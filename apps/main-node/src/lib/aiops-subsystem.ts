// AIOps subsystem — the single enterprise-line composition point for the
// closed-loop AIOps capability (docs/aiops-closed-loop.md):
//
//   alert webhook → normalize/dedup → dispatch sweeper → triage session
//   → analysis (CMDB/ITSM/opsdata tools) → approval request → human decide
//   → gated execution → ITSM write-back.
//
// Upgrade isolation (docs/aiops-closed-loop.md §升级隔离): everything the
// subsystem needs is injected structurally — index.ts mounts the returned
// Hono app behind AIOPS_ENABLED=1 and registers the returned cron jobs via
// the scheduler's generic extraJobs hook. No upstream file imports anything
// from here, and this module never imports index.ts internals.

import { Hono } from "hono";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { getLogger } from "@open-managed-agents/observability";
import {
  normalizeAlertPayload,
  renderAlertOccurrenceSignal,
  renderAlertResolvedSignal,
  renderAlertSignal,
  aiopsDispatchTick,
  type AiopsAlert,
  type AiopsAlertStore,
  type AiopsDispatchSweeper,
  type AiopsDispatchTickResult,
} from "@open-managed-agents/aiops";
import { z } from "zod";
import { FakeCmpConnector } from "@open-managed-agents/cmp";
import { SqlAiopsAlertStore } from "./aiops-alert-store.js";
import { SqlApprovalStore } from "./approval-store.js";
import {
  configureCmpAgentTools,
  resetCmpAgentTools,
} from "./cmp-agent-tools.js";

const log = getLogger("aiops.subsystem");

export const DEFAULT_TRIAGE_AGENT_NAME = "alert-triage-operator";

export interface AiopsSubsystemDeps {
  sql: SqlClient;
  env: NodeJS.ProcessEnv;
  /** Dev bypass flag from the host (AUTH_DISABLED). */
  authDisabled: boolean;
  /** Structural slices — keeps this module independent of index.ts types. */
  agents: {
    list(opts: {
      tenantId: string;
      includeArchived?: boolean;
    }): Promise<ReadonlyArray<{ id: string; name: string }>>;
  };
  sessions: {
    create(opts: {
      tenantId: string;
      agentId: string;
      environmentId: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ session: { id: string } }>;
  };
  /** Append a user.message turn to a session (drives the harness). */
  appendUserMessage: (sessionId: string, text: string) => Promise<void>;
  localRuntimeEnvId: string;
}

export interface AiopsSubsystemJobs {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export interface AiopsSubsystem {
  /** Typed to mirror the host's v1 app so `v1.route("/aiops", app)`
   *  typechecks without casts. */
  app: Hono<{ Variables: { tenant_id: string; user_id?: string } }>;
  jobs: AiopsSubsystemJobs[];
  alerts: AiopsAlertStore & { listForTenant: SqlAiopsAlertStore["listForTenant"] };
  approvals: SqlApprovalStore;
  sweeper: AiopsDispatchSweeper;
}

export function registerAiopsSubsystem(
  deps: AiopsSubsystemDeps,
): AiopsSubsystem {
  const env = deps.env;
  const dedupWindowMs = intEnv(env.AIOPS_DEDUP_WINDOW_MS, 15 * 60_000);

  const alerts = new SqlAiopsAlertStore({ sql: deps.sql });
  const approvals = new SqlApprovalStore({ sql: deps.sql });
  // Contract-first: fake connector until the CMP HTTP adapter lands
  // (docs/aiops-closed-loop.md §CMP 接入面). Swap at this single line.
  const cmp = new FakeCmpConnector({ autoComplete: true });

  configureCmpAgentTools({
    approvals,
    cmp,
    readSessionInfo: async (sessionId) => {
      const row = await deps.sql
        .prepare(`SELECT tenant_id, metadata FROM sessions WHERE id = ?`)
        .bind(sessionId)
        .first<{ tenant_id: string; metadata: string | null }>();
      if (!row) return null;
      let alertId: string | null = null;
      try {
        const meta = row.metadata ? JSON.parse(row.metadata) : null;
        if (meta && typeof meta.alertId === "string") alertId = meta.alertId;
      } catch {
        /* metadata is optional */
      }
      return { tenantId: row.tenant_id, alertId };
    },
  });

  const triageAgentCache = new Map<string, string>();
  async function resolveTriageAgent(tenantId: string): Promise<string> {
    const cached = triageAgentCache.get(tenantId);
    if (cached) return cached;
    const explicit = env.AIOPS_TRIAGE_AGENT_ID;
    if (explicit) {
      triageAgentCache.set(tenantId, explicit);
      return explicit;
    }
    const wanted = env.AIOPS_TRIAGE_AGENT_NAME ?? DEFAULT_TRIAGE_AGENT_NAME;
    const found = (await deps.agents.list({ tenantId })).find(
      (a) => a.name === wanted,
    );
    if (!found) {
      throw new Error(
        `AIOps triage agent "${wanted}" not found for tenant ${tenantId} — seed it with scripts/seed-aiops-operators.ts`,
      );
    }
    triageAgentCache.set(tenantId, found.id);
    return found.id;
  }

  const sweeper: AiopsDispatchSweeper = {
    async runDispatchTick(
      nowMs: number,
      alertLimit: number,
    ): Promise<AiopsDispatchTickResult> {
      const claimed = await alerts.claimNew(alertLimit, nowMs);
      let dispatched = 0;
      let resumed = 0;
      const errors: Array<{ alertId: string; message: string }> = [];
      for (const alert of claimed) {
        try {
          const agentId = await resolveTriageAgent(alert.tenantId);
          const open = await alerts.getOpenByFingerprint(
            alert.tenantId,
            alert.fingerprint,
          );
          if (open && open.sessionId && open.id !== alert.id) {
            // An open triage session already covers this fingerprint —
            // fold this occurrence into it (requirement 3: 相关性/查重).
            await deps.appendUserMessage(
              open.sessionId,
              renderAlertOccurrenceSignal(alert),
            );
            await alerts.attachSession(alert.id, open.sessionId);
            resumed++;
            continue;
          }
          const { session } = await deps.sessions.create({
            tenantId: alert.tenantId,
            agentId,
            environmentId: deps.localRuntimeEnvId,
            title: `AIOps 分诊: ${alert.name}`,
            metadata: {
              domain: "aiops",
              kind: "alert_triage",
              alertId: alert.id,
              fingerprint: alert.fingerprint,
            },
          });
          await deps.appendUserMessage(session.id, renderAlertSignal(alert));
          await alerts.attachSession(alert.id, session.id);
          dispatched++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ alertId: alert.id, message });
          await alerts.attachError(alert.id, message).catch(() => undefined);
        }
      }
      return {
        claimed: claimed.length,
        dispatched,
        resumed,
        failed: errors.length,
        errors,
      };
    },
  };

  // ── HTTP surface (mounted at /v1/aiops by the host) ────────────────────
  const app: AiopsSubsystem["app"] = new Hono<{
    Variables: { tenant_id: string; user_id?: string };
  }>();

  app.post("/alerts", async (c) => {
    const tenantId = c.var.tenant_id as string;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    let inputs;
    try {
      inputs = normalizeAlertPayload(body, Date.now());
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json(
          { error: "invalid alert payload", issues: err.issues },
          400,
        );
      }
      return c.json({ error: "alert normalization failed" }, 400);
    }
    const nowMs = Date.now();
    const results: Array<{ alert_id: string; deduped: boolean; resolved: boolean }> = [];
    for (const input of inputs) {
      const { alert, deduped } = await alerts.insertDedup(
        tenantId,
        input,
        dedupWindowMs,
        nowMs,
      );
      let resolved = false;
      if (input.resolved) {
        await alerts.markResolved(alert.id, input.endsAt ?? nowMs);
        resolved = true;
        if (alert.sessionId) {
          await sendSafe(deps, alert.sessionId, renderAlertResolvedSignal(alert));
        }
      } else if (deduped && alert.sessionId) {
        // Occurrence on an already-dispatched alert: resume its session now
        // (in-window dedup folds don't re-enter the sweeper).
        await sendSafe(
          deps,
          alert.sessionId,
          renderAlertOccurrenceSignal(alert),
        );
      }
      results.push({ alert_id: alert.id, deduped, resolved });
    }
    return c.json({ accepted: results.length, results }, 201);
  });

  app.get("/alerts", async (c) => {
    const tenantId = c.var.tenant_id as string;
    const severity = c.req.query("severity");
    const status = c.req.query("status");
    const limit = intOr(c.req.query("limit"), 100);
    const data = await alerts.listForTenant(tenantId, {
      severity:
        severity === "critical" || severity === "warning" || severity === "info"
          ? severity
          : undefined,
      status: isAlertStatus(status) ? status : undefined,
      limit,
    });
    return c.json({ data: data.map(alertToWire) });
  });

  // ── Approval queue + decide (requirement 5: 审批) ──────────────────────

  app.get("/approvals", async (c) => {
    const tenantId = c.var.tenant_id as string;
    const status = c.req.query("status");
    const limit = intOr(c.req.query("limit"), 100);
    const data = await approvals.list(tenantId, {
      status:
        status === "pending" ||
        status === "approved" ||
        status === "rejected" ||
        status === "expired"
          ? status
          : "pending",
      limit,
    });
    return c.json({ data: data.map(approvalToWire) });
  });

  app.post("/approvals/:id/decide", async (c) => {
    const tenantId = c.var.tenant_id as string;
    const userId = c.var.user_id as string | undefined;
    // Human-only gate: a user-scoped principal must decide. Tenant-wide
    // agent API keys carry no user_id and are rejected; AUTH_DISABLED dev
    // mode decides as "dev-user" (documented in docs/aiops-closed-loop.md).
    if (!deps.authDisabled && !userId) {
      return c.json(
        {
          error:
            "approvals can only be decided by a human principal (user-scoped API key), not a tenant-wide agent key",
        },
        403,
      );
    }
    const decidedBy = userId ?? "dev-user";
    let body: { decision?: string; reason?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.decision !== "approve" && body.decision !== "reject") {
      return c.json({ error: "decision must be 'approve' or 'reject'" }, 400);
    }
    const res = await approvals.decide({
      id: c.req.param("id"),
      tenantId,
      decision: body.decision,
      decidedBy,
      reason: body.reason,
      nowMs: Date.now(),
    });
    if (!res.ok) {
      const statusByCode = {
        not_found: 404,
        wrong_tenant: 404,
        expired: 409,
        already_decided: 409,
      } as const;
      return c.json({ error: res.code }, statusByCode[res.code]);
    }
    // Decision continuation (requirement 5: 审批 → 执行 → 回写): re-enter
    // the triage session so the operator executes the approved action via
    // the gated tool, then writes the result back to ITSM.
    const a = res.approval;
    const text =
      a.status === "approved"
        ? [
            `审批已通过（approval_id=${a.id}，审批人 ${decidedBy}）。`,
            `动作：${a.action.summary}（runbook=${a.action.runbook_id}，参数 ${JSON.stringify(a.action.params)}）。`,
            "请调用 cmp__automation_execute 执行该动作（approval_id 见上），随后把执行结果回写 ITSM 工单。",
          ].join("\n")
        : [
            `审批被拒绝（approval_id=${a.id}，审批人 ${decidedBy}）。`,
            a.reason ? `理由：${a.reason}` : "",
            "请停止该处置动作，将拒绝结论回写 ITSM 工单并收口。",
          ]
            .filter(Boolean)
            .join("\n");
    await sendSafe(deps, a.sessionId, text);
    return c.json({ approval: approvalToWire(a) });
  });

  const jobs: AiopsSubsystemJobs[] = [
    {
      name: "aiops-dispatch",
      cron: env.AIOPS_DISPATCH_CRON ?? "* * * * *",
      handler: aiopsDispatchTick({ resolveSweeper: async () => sweeper }),
    },
    {
      name: "aiops-approval-expiry",
      cron: env.AIOPS_APPROVAL_EXPIRY_CRON ?? "* * * * *",
      handler: async () => {
        const flipped = await approvals.expireStale(Date.now());
        if (flipped > 0) {
          log.info({ op: "aiops.approval_expiry", flipped }, "expired stale approvals");
        }
      },
    },
  ];

  return { app, jobs, alerts, approvals, sweeper };
}

/** Test seam: drop the global cmp tool config (mirrors feishu reset). */
export function teardownAiopsSubsystem(): void {
  resetCmpAgentTools();
}

async function sendSafe(
  deps: AiopsSubsystemDeps,
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    await deps.appendUserMessage(sessionId, text);
  } catch (err) {
    log.warn(
      { err, op: "aiops.subsystem.send_failed", session_id: sessionId },
      "failed to append user message",
    );
  }
}

function intEnv(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Wire style matches the rest of /v1 (snake_case rows). */
function alertToWire(a: AiopsAlert) {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    source: a.source,
    fingerprint: a.fingerprint,
    severity: a.severity,
    name: a.name,
    labels: a.labels,
    annotations: a.annotations,
    starts_at: a.startsAt,
    ends_at: a.endsAt,
    dedup_count: a.dedupCount,
    last_seen_at: a.lastSeenAt,
    session_id: a.sessionId,
    status: a.status,
    error: a.error,
    created_at: a.createdAt,
  };
}

function approvalToWire(a: {
  id: string;
  tenantId: string;
  sessionId: string;
  alertId: string | null;
  action: unknown;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: number | null;
  expiresAt: number;
  reason: string | null;
  createdAt: number;
}) {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    session_id: a.sessionId,
    alert_id: a.alertId,
    action: a.action,
    status: a.status,
    requested_by: a.requestedBy,
    decided_by: a.decidedBy,
    decided_at: a.decidedAt,
    expires_at: a.expiresAt,
    reason: a.reason,
    created_at: a.createdAt,
  };
}

function intOr(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isAlertStatus(v: string | undefined): v is AiopsAlert["status"] {
  return (
    v === "new" ||
    v === "dispatching" ||
    v === "dispatched" ||
    v === "error" ||
    v === "deduped" ||
    v === "resolved"
  );
}
