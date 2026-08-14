// AIOps subsystem — closed-loop integration test against real sqlite
// migrations: webhook → dedup → dispatch sweeper → triage session →
// approval decide (human-only) → gated execute → ITSM write-back signals.
// Session/harness side is faked structurally (appendUserMessage capture);
// the approval gate + tools run for real.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";
import {
  registerAiopsSubsystem,
  teardownAiopsSubsystem,
  type AiopsSubsystem,
  type AiopsSubsystemDeps,
} from "../src/lib/aiops-subsystem.js";
import { buildCmpTools, resetCmpAgentTools } from "../src/lib/cmp-agent-tools.js";
import { FakeCmpConnector } from "@open-managed-agents/cmp";
import type { ApprovalAction } from "../src/lib/approval-store.js";

const TENANT = "tenant-sub";

let testDb: TestDb | undefined;
let sys: AiopsSubsystem;
let host: Hono<{ Variables: { tenant_id: string; user_id?: string } }>;
let user_id: string | undefined;
let authDisabled = true;

const sentMessages: Array<{ sessionId: string; text: string }> = [];
const createdSessions: Array<{
  tenantId: string;
  agentId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}> = [];
let seq = 0;
let agents: ReadonlyArray<{ id: string; name: string }> = [
  { id: "agent_triage", name: "alert-triage-operator" },
];

function deps(): AiopsSubsystemDeps {
  return {
    sql: testDb!.sql,
    env: {},
    get authDisabled() {
      return authDisabled;
    },
    agents: { list: async () => agents },
    sessions: {
      create: async (opts) => {
        createdSessions.push({
          tenantId: opts.tenantId,
          agentId: opts.agentId,
          title: opts.title,
          metadata: opts.metadata,
        });
        return { session: { id: `sess_${++seq}` } };
      },
    },
    appendUserMessage: async (sessionId, text) => {
      sentMessages.push({ sessionId, text });
    },
    localRuntimeEnvId: "env-local-runtime",
  };
}

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: false });
  sys = registerAiopsSubsystem(deps());
  host = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  host.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    if (user_id) c.set("user_id", user_id);
    await next();
  });
  host.route("/aiops", sys.app);
});

afterAll(() => {
  teardownAiopsSubsystem();
  resetCmpAgentTools();
  testDb?.cleanup();
});

function alertmanagerBody(overrides: Record<string, unknown> = {}) {
  return {
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPU", host: "web-01", severity: "warning" },
        annotations: { summary: "CPU 95%" },
        startsAt: "2026-08-14T00:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: "fp_sub_cpu",
        ...overrides,
      },
    ],
  };
}

describe("webhook ingress", () => {
  it("accepts an alertmanager payload and stores a new alert", async () => {
    const res = await host.request("/aiops/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertmanagerBody()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      accepted: number;
      results: Array<{ alert_id: string; deduped: boolean; resolved: boolean }>;
    };
    expect(body.accepted).toBe(1);
    expect(body.results[0].deduped).toBe(false);
    expect(body.results[0].resolved).toBe(false);
  });

  it("folds a redelivery into the same alert (dedup)", async () => {
    const res = await host.request("/aiops/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertmanagerBody()),
    });
    const body = (await res.json()) as {
      results: Array<{ alert_id: string; deduped: boolean }>;
    };
    expect(body.results[0].deduped).toBe(true);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await host.request("/aiops/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("lists alerts for the tenant", async () => {
    const res = await host.request("/aiops/alerts?severity=warning");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ fingerprint: string; severity: string }>;
    };
    expect(body.data.some((a) => a.fingerprint === "fp_sub_cpu")).toBe(true);
  });
});

describe("dispatch sweeper", () => {
  it("creates a triage session and injects the alert_fired signal", async () => {
    const res = await sys.sweeper.runDispatchTick(Date.now(), 10);
    expect(res.dispatched).toBe(1);
    expect(res.failed).toBe(0);
    expect(createdSessions.at(-1)?.agentId).toBe("agent_triage");
    expect(createdSessions.at(-1)?.metadata?.alertId).toBeDefined();
    const fired = sentMessages.find((m) =>
      m.text.includes('kind="alert_fired"'),
    );
    expect(fired).toBeDefined();
    expect(fired!.text).toContain("HighCPU");
  });

  it("resumes the open session for a same-fingerprint new row", async () => {
    // Simulate a post-window re-fire: brand-new row, same fingerprint,
    // while the first alert is still dispatched with a session. A negative
    // dedup window forces a fresh row even at identical timestamps.
    const now = Date.now();
    await sys.alerts.insertDedup(
      TENANT,
      {
        source: "alertmanager",
        fingerprint: "fp_sub_cpu",
        severity: "critical",
        name: "HighCPU",
        labels: {},
        annotations: {},
        startsAt: now,
        endsAt: null,
        resolved: false,
      },
      -1, // never dedup → fresh row every time
      now,
    );
    const res = await sys.sweeper.runDispatchTick(now, 10);
    expect(res.resumed).toBe(1);
    const occurrence = sentMessages
      .filter((m) => m.text.includes('kind="alert_occurrence"'))
      .at(-1);
    expect(occurrence).toBeDefined();
  });

  it("records an error when no triage agent is configured", async () => {
    // Fresh tenant → triage-agent cache is cold for it; with the agent
    // list emptied, resolution must fail and attachError the alert.
    const now = Date.now();
    await sys.alerts.insertDedup(
      "tenant-no-agent",
      {
        source: "alertmanager",
        fingerprint: "fp_no_agent",
        severity: "info",
        name: "NoAgent",
        labels: {},
        annotations: {},
        startsAt: now,
        endsAt: null,
        resolved: false,
      },
      0,
      now,
    );
    const saved = agents;
    agents = [];
    try {
      const res = await sys.sweeper.runDispatchTick(now, 10);
      expect(res.failed).toBe(1);
      const errAlert = res.errors[0];
      expect(errAlert?.message).toContain("alert-triage-operator");
    } finally {
      agents = saved;
    }
  });
});

describe("resolution + occurrence at ingest", () => {
  it("marks the open alert resolved and notifies its session", async () => {
    const res = await host.request("/aiops/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        alertmanagerBody({
          status: "resolved",
          endsAt: "2026-08-14T01:00:00Z",
          severity: "info",
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { results: Array<{ resolved: boolean }> };
    expect(body.results[0].resolved).toBe(true);
    const resolvedMsg = sentMessages.find((m) =>
      m.text.includes('kind="alert_resolved"'),
    );
    expect(resolvedMsg).toBeDefined();
  });
});

describe("approval gate", () => {
  let approvalId: string;

  async function createPending(action?: Partial<ApprovalAction>) {
    const full: ApprovalAction = {
      kind: "automation_execute",
      runbook_id: "rb_restart_service",
      params: { hostname: "web-01", service: "nginx" },
      summary: "重启 web-01 的 nginx",
      ...action,
    };
    return sys.approvals.create({
      tenantId: TENANT,
      sessionId: "sess_1",
      alertId: null,
      action: full,
      requestedBy: "agent",
      expiresAt: Date.now() + 3600_000,
      nowMs: Date.now(),
    });
  }

  it("lists pending approvals", async () => {
    const a = await createPending();
    approvalId = a.id;
    const res = await host.request("/aiops/approvals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; status: string }> };
    expect(body.data.some((x) => x.id === approvalId && x.status === "pending")).toBe(true);
  });

  it("rejects non-human principals when auth is enabled", async () => {
    authDisabled = false;
    user_id = undefined;
    try {
      const res = await host.request(`/aiops/approvals/${approvalId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(res.status).toBe(403);
    } finally {
      authDisabled = true;
    }
  });

  it("a human principal approves; the session receives the continuation", async () => {
    user_id = "user_alice";
    const res = await host.request(`/aiops/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { status: string; decided_by: string } };
    expect(body.approval.status).toBe("approved");
    expect(body.approval.decided_by).toBe("user_alice");
    const continuation = sentMessages
      .filter((m) => m.sessionId === "sess_1")
      .at(-1);
    expect(continuation?.text).toContain("审批已通过");
    expect(continuation?.text).toContain(approvalId);
    expect(continuation?.text).toContain("cmp__automation_execute");
  });

  it("double-deciding is a 409", async () => {
    user_id = "user_alice";
    const res = await host.request(`/aiops/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(res.status).toBe(409);
  });

  it("reject flow sends the stop message", async () => {
    const a = await createPending({ summary: "扩容 api 服务" });
    user_id = "user_bob";
    const res = await host.request(`/aiops/approvals/${a.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", reason: "变更窗口未到" }),
    });
    expect(res.status).toBe(200);
    const last = sentMessages.at(-1);
    expect(last?.text).toContain("审批被拒绝");
    expect(last?.text).toContain("变更窗口未到");
  });

  it("expired approvals cannot be decided (409) — expiry tick flips them", async () => {
    const stale = await sys.approvals.create({
      tenantId: TENANT,
      sessionId: "sess_1",
      alertId: null,
      action: {
        kind: "automation_execute",
        runbook_id: "rb_disk_clean",
        params: {},
        summary: "清理磁盘",
      },
      requestedBy: "agent",
      expiresAt: Date.now() - 1,
      nowMs: Date.now(),
    });
    const flipped = await sys.approvals.expireStale(Date.now());
    expect(flipped).toBeGreaterThanOrEqual(1);
    user_id = "user_alice";
    const res = await host.request(`/aiops/approvals/${stale.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("cmp tool gate (server-side enforcement)", () => {
  const cmp = new FakeCmpConnector({ autoComplete: true });
  const cfg = {
    approvals: null as never,
    cmp,
    readSessionInfo: async () => ({ tenantId: TENANT, alertId: null }),
    now: () => Date.now(),
  };

  it("execute refuses without an approved record for THIS session+runbook", async () => {
    cfg.approvals = sys.approvals as never;
    const tools = buildCmpTools("sess_gate", cfg);
    const execute = tools["cmp__automation_execute"].execute as (
      input: { runbook_id: string; params: Record<string, unknown>; approval_id: string },
    ) => Promise<{ ok: boolean; error?: string }>;

    const pending = await sys.approvals.create({
      tenantId: TENANT,
      sessionId: "sess_gate",
      alertId: null,
      action: {
        kind: "automation_execute",
        runbook_id: "rb_restart_service",
        params: { hostname: "web-01", service: "nginx" },
        summary: "重启 nginx",
      },
      requestedBy: "agent",
      expiresAt: Date.now() + 3600_000,
      nowMs: Date.now(),
    });

    // pending → refused
    const r1 = await execute({
      runbook_id: "rb_restart_service",
      params: {},
      approval_id: pending.id,
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("尚未获得人工批准");

    // approved for a different runbook → refused
    user_id = "user_alice";
    await sys.approvals.decide({
      id: pending.id,
      tenantId: TENANT,
      decision: "approve",
      decidedBy: "user_alice",
      nowMs: Date.now(),
    });
    const r2 = await execute({
      runbook_id: "rb_disk_clean",
      params: {},
      approval_id: pending.id,
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("不一致");

    // approved + matching runbook + right session → executes
    const r3 = await execute({
      runbook_id: "rb_restart_service",
      params: { hostname: "web-01", service: "nginx" },
      approval_id: pending.id,
    });
    expect(r3.ok).toBe(true);
  });

  it("an approval from another session never unlocks execution", async () => {
    const foreign = await sys.approvals.create({
      tenantId: TENANT,
      sessionId: "sess_OTHER",
      alertId: null,
      action: {
        kind: "automation_execute",
        runbook_id: "rb_disk_clean",
        params: {},
        summary: "别处的审批",
      },
      requestedBy: "agent",
      expiresAt: Date.now() + 3600_000,
      nowMs: Date.now(),
    });
    await sys.approvals.decide({
      id: foreign.id,
      tenantId: TENANT,
      decision: "approve",
      decidedBy: "user_alice",
      nowMs: Date.now(),
    });
    const tools = buildCmpTools("sess_gate", cfg);
    const execute = tools["cmp__automation_execute"].execute as (
      input: { runbook_id: string; params: Record<string, unknown>; approval_id: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    const res = await execute({
      runbook_id: "rb_disk_clean",
      params: {},
      approval_id: foreign.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("不属于当前会话");
  });
});
