// Base E · Approval Timeout Scheduler (run-model spec §6.3 裁决 5, template spec §3.2).
//
// Scans runs parked in awaiting_approval and fires the template version's
// escalation_actions at their at_minute thresholds. The ONLY outcomes are:
//   ① 催办 — Feishu interactive card into the policy's target chat
//   ② process-owner notify — audit-recorded, not yet delivered (no
//      user↔open_id directory in P0; debt F7)
//   ③ 按策略取消 — the SAME CAS path as a human cancel (state-matrix row 3),
//      cancel_reason=approval_timeout, run.cancel audit by the system actor.
// There is NO auto-approve path anywhere in this file — 裁决 5 is a system
// invariant, not a configuration.
//
// Timeout anchor: runs.updated_at — refreshed on entering awaiting_approval
// AND on every stage advance, so each stage restarts the clock.
//
// Anti-spam: each action gets ONE chance per tick loop. The dedup marker
// (run_events, action=run.escalation, payload.dedup_key) is recorded
// immediately AFTER the attempt with its outcome — a FAILED send is still
// marked, so a persistent Feishu hiccup cannot storm every tick. Crash
// window tradeoff: a process dying in the instant between "card sent" and
// "marker written" re-sends once on the next tick (bounded: one action, one
// run, no cascade); marker-write failure aborts the run's remaining actions.
//
// Concurrency: if a human decides the run between scan and action, the
// cancel path hits the CAS guard inside cancelRun and the conflict is
// swallowed — the human always wins.

import { getLogger } from "@open-managed-agents/observability";
import {
  RunStateConflictError,
  InvalidStateTransitionError,
  escalationActionsDue,
  escalationDedupKey,
  parseTimeoutPolicy,
  type AuditActor,
  type EscalationActionRule,
  type OperationsService,
  type RunRow,
} from "@open-managed-agents/operations-store";

const log = getLogger("operations-timeout-scheduler");

/** System actor for policy cancels — appears in run.cancel audit + SSE frames. */
export const SYSTEM_TIMEOUT_ACTOR: AuditActor = {
  type: "system",
  id: "system_approval_timeout",
  name: "Approval Timeout Scheduler",
};

export interface TimeoutSchedulerOptions {
  service: OperationsService;
  /** Egress for escalation cards (injected: FeishuApiClient.sendCard in prod). */
  sendCard: (chatId: string, card: unknown) => Promise<void>;
  /** Wall clock; default Date.now. */
  nowMs?: () => number;
  /** Tick interval; default 60s. */
  intervalMs?: number;
  /** Workspace deep-link base for card buttons; default http://localhost:5175. */
  workspaceBaseUrl?: string;
  /** Optional SSE bridge — fanned on every escalation action. */
  onEvent?: (
    tenantId: string,
    runId: string,
    eventType: "run.escalation",
    payload: Record<string, unknown>,
  ) => void;
}

export interface TimeoutSchedulerHandle {
  /** One scan-and-act pass. Serial: the interval loop never overlaps ticks. */
  tick(): Promise<TimeoutTickStats>;
  stop(): Promise<void>;
}

export interface TimeoutTickStats {
  scanned: number;
  notified: number;
  cancelled: number;
  skipped: number;
  errors: number;
}

const SCAN_LIMIT = 200;
const DEDUP_EVENT_ACTION = "run.escalation";

export function startOperationsTimeoutScheduler(
  opts: TimeoutSchedulerOptions,
): TimeoutSchedulerHandle {
  const now = opts.nowMs ?? Date.now;
  const intervalMs = opts.intervalMs ?? 60_000;
  const workspaceBaseUrl = (opts.workspaceBaseUrl ?? "http://localhost:5175").replace(/\/$/, "");
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let stopped = false;

  async function runTick(): Promise<TimeoutTickStats> {
    const stats: TimeoutTickStats = { scanned: 0, notified: 0, cancelled: 0, skipped: 0, errors: 0 };
    const runs = await opts.service.listAwaitingApprovalRuns(SCAN_LIMIT);
    stats.scanned = runs.length;

    for (const run of runs) {
      try {
        const outcome = await processRun(run, now(), workspaceBaseUrl, opts);
        stats.notified += outcome.notified;
        stats.cancelled += outcome.cancelled;
        stats.skipped += outcome.skipped ? 1 : 0;
        stats.errors += outcome.errors;
      } catch (err) {
        // One bad run must never kill the whole tick.
        stats.errors++;
        log.error(
          { op: "timeout_scheduler.run_failed", run_id: run.id, tenant_id: run.tenant_id, err },
          "timeout scheduler run processing failed",
        );
      }
    }
    return stats;
  }

  const handle: TimeoutSchedulerHandle = {
    tick: async () => {
      if (inFlight) {
        // Interval loop guard — manual tick() during an in-flight tick is a no-op.
        return { scanned: 0, notified: 0, cancelled: 0, skipped: 0, errors: 0 };
      }
      inFlight = true;
      try {
        return await runTick();
      } finally {
        inFlight = false;
      }
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  timer = setInterval(() => {
    if (stopped) return;
    void handle.tick().catch((err) => {
      log.error({ op: "timeout_scheduler.tick_failed", err }, "timeout scheduler tick failed");
    });
  }, intervalMs);
  // Node default: the interval must not hold the process open in tests.
  timer.unref?.();

  return handle;
}

async function processRun(
  run: RunRow,
  nowMs: number,
  workspaceBaseUrl: string,
  opts: TimeoutSchedulerOptions,
): Promise<{ notified: number; cancelled: number; skipped: boolean; errors: number }> {
  // K1: the run is pinned to its template version; version content fields
  // are immutable post-publish (R4), so reading the version row IS reading
  // the run's frozen snapshot.
  let versionRow;
  try {
    versionRow = await opts.service.getTemplateVersion(run.tenant_id, run.template_version_id);
  } catch {
    return { notified: 0, cancelled: 0, skipped: true, errors: 0 };
  }
  const policy = parseTimeoutPolicy(versionRow.timeout_policy);
  if (!policy) {
    log.warn(
      { op: "timeout_scheduler.bad_policy", run_id: run.id, tenant_id: run.tenant_id },
      "unparseable timeout_policy; skipping run",
    );
    return { notified: 0, cancelled: 0, skipped: true, errors: 0 };
  }

  const elapsedMinutes = Math.max(0, (nowMs - run.updated_at) / 60_000);
  const due = escalationActionsDue(policy, elapsedMinutes);
  if (due.length === 0) return { notified: 0, cancelled: 0, skipped: false, errors: 0 };

  const executedKeys = await loadExecutedKeys(opts.service, run.tenant_id, run.id);

  let notified = 0;
  let cancelled = 0;
  let errors = 0;

  for (const rule of due) {
    const key = escalationDedupKey(rule);
    if (executedKeys.has(key)) continue;

    // Execute, then persist the dedup marker with the outcome (see header
    // comment for the crash-window tradeoff).
    const delivered = await executeAction(rule, run, elapsedMinutes, workspaceBaseUrl, opts).catch(
      (err) => {
        errors++;
        log.error(
          { op: "timeout_scheduler.action_failed", run_id: run.id, action: rule.action, err },
          "escalation action failed",
        );
        return false;
      },
    );

    try {
      await opts.service.recordAuditEvent({
        tenantId: run.tenant_id,
        resourceType: "run",
        resourceId: run.id,
        runId: run.id,
        actor: SYSTEM_TIMEOUT_ACTOR,
        action: DEDUP_EVENT_ACTION,
        phase: "reconciliation",
        result: "success",
        fromState: "awaiting_approval",
        ...(rule.action === "mark_approval_overdue_and_cancel" ? { toState: "cancelled" } : {}),
        payload: {
          dedup_key: key,
          action: rule.action,
          at_minute: rule.atMinute,
          elapsed_minutes: Math.round(elapsedMinutes),
          delivered,
        },
      });
    } catch (err) {
      // Marker write failed — do NOT execute more actions for this run this
      // tick (risk of unbounded re-send), but the already-attempted action
      // must not be silently lost either. Log and stop processing this run.
      errors++;
      log.error(
        { op: "timeout_scheduler.marker_failed", run_id: run.id, dedup_key: key, err },
        "failed to persist escalation dedup marker; aborting run processing",
      );
      break;
    }

    opts.onEvent?.(run.tenant_id, run.id, "run.escalation", {
      action: rule.action,
      at_minute: rule.atMinute,
      dedup_key: key,
      delivered,
    });

    if (rule.action === "notify_feishu_group" && delivered) notified++;
    if (rule.action === "mark_approval_overdue_and_cancel" && delivered) cancelled++;
    executedKeys.add(key);
  }

  return { notified, cancelled, skipped: false, errors };
}

/** Persisted dedup keys for this run (action:atMinute, one chance each). */
async function loadExecutedKeys(
  service: OperationsService,
  tenantId: string,
  runId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const events = await service.listEvents(tenantId, runId, 500);
  for (const e of events) {
    if (e.action !== DEDUP_EVENT_ACTION || !e.payload) continue;
    try {
      const parsed = JSON.parse(e.payload) as { dedup_key?: string };
      if (parsed.dedup_key) keys.add(parsed.dedup_key);
    } catch {
      // Corrupt payload — ignore that row.
    }
  }
  return keys;
}

/**
 * Execute one action. Returns whether the action's intended effect happened
 * (card sent / cancel transitioned). Throws propagate to the caller EXCEPT
 * CAS races, which are correct outcomes (human won) and return false.
 */
async function executeAction(
  rule: EscalationActionRule,
  run: RunRow,
  elapsedMinutes: number,
  workspaceBaseUrl: string,
  opts: TimeoutSchedulerOptions,
): Promise<boolean> {
  switch (rule.action) {
    case "notify_feishu_group": {
      if (!rule.target) {
        log.warn(
          { op: "timeout_scheduler.no_target", run_id: run.id },
          "notify_feishu_group without target chat_id; not delivered",
        );
        return false;
      }
      await opts.sendCard(rule.target, buildEscalationCard(run, elapsedMinutes, workspaceBaseUrl));
      return true;
    }
    case "notify_process_owner": {
      // P0: no user↔open_id directory exists to resolve a direct-message
      // recipient — audit the attempt honestly instead of faking delivery.
      // Debt F7.
      log.info(
        { op: "timeout_scheduler.owner_notify_unsupported", run_id: run.id, channel: rule.channel ?? null },
        "notify_process_owner recorded but not delivered in P0 (debt F7)",
      );
      return false;
    }
    case "mark_approval_overdue_and_cancel": {
      try {
        await opts.service.cancelRun({
          tenantId: run.tenant_id,
          runId: run.id,
          actor: SYSTEM_TIMEOUT_ACTOR,
          reason: "approval_timeout",
        });
        return true;
      } catch (err) {
        if (err instanceof RunStateConflictError || err instanceof InvalidStateTransitionError) {
          // The run was decided by a human between scan and action — their
          // decision stands. 裁决 5 invariant: never force anything else.
          log.info(
            { op: "timeout_scheduler.cancel_lost_race", run_id: run.id },
            "run left awaiting_approval before policy cancel; human decision preserved",
          );
          return false;
        }
        throw err;
      }
    }
  }
}

/** Feishu interactive card (msg_type=interactive) for escalation reminders. */
function buildEscalationCard(
  run: RunRow,
  elapsedMinutes: number,
  workspaceBaseUrl: string,
): unknown {
  const runUrl = `${workspaceBaseUrl}/runs/${run.id}`;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "⏰ 审批超时催办" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**工单**：${run.title}`,
            `**工单 ID**：${run.id}`,
            `**申请人**：${run.created_by}`,
            `**当前状态**：awaiting_approval（Stage ${run.current_approval_stage}）`,
            `**已等待**：${Math.round(elapsedMinutes)} 分钟`,
          ].join("\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "前往审批" },
            type: "primary",
            url: runUrl,
          },
        ],
      },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: "系统催办通知 · Operations Workspace 审批超时调度器" },
        ],
      },
    ],
  };
}
