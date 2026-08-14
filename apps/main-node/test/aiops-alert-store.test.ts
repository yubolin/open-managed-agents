// SqlAiopsAlertStore — SQL adapter against the real sqlite migration chain.
// Semantics must mirror packages/aiops/src/test-fakes.ts (the reference
// implementation); claimNew must be exclusive across store instances
// (multi-replica simulation).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";
import { SqlAiopsAlertStore } from "../src/lib/aiops-alert-store.js";
import type { NormalizedAlertInput } from "@open-managed-agents/aiops";

const TENANT = "tenant-aiops";
const OTHER = "tenant-other";
const WINDOW = 15 * 60_000;

let testDb: TestDb | undefined;
let store: SqlAiopsAlertStore;

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: false });
  store = new SqlAiopsAlertStore({ sql: testDb.sql });
});

afterAll(() => {
  testDb?.cleanup();
});

function input(partial: Partial<NormalizedAlertInput> = {}): NormalizedAlertInput {
  return {
    source: "alertmanager",
    fingerprint: "fp_cpu",
    severity: "warning",
    name: "HighCPU",
    labels: { alertname: "HighCPU", host: "web-01" },
    annotations: { summary: "CPU 95%" },
    startsAt: 1_700_000_000_000,
    endsAt: null,
    resolved: false,
    ...partial,
  };
}

describe("insertDedup", () => {
  it("inserts a fresh alert when no open fingerprint row exists", async () => {
    const now = 1_700_000_000_000;
    const res = await store.insertDedup(TENANT, input(), WINDOW, now);
    expect(res.deduped).toBe(false);
    expect(res.alert.status).toBe("new");
    expect(res.alert.dedupCount).toBe(1);
    expect(res.alert.labels).toEqual({ alertname: "HighCPU", host: "web-01" });
  });

  it("folds an in-window occurrence: count+1, severity escalates, endsAt fills", async () => {
    const now = 1_700_000_000_000 + 60_000;
    const res = await store.insertDedup(
      TENANT,
      input({ severity: "critical", endsAt: now }),
      WINDOW,
      now,
    );
    expect(res.deduped).toBe(true);
    expect(res.alert.dedupCount).toBe(2);
    expect(res.alert.severity).toBe("critical");
    expect(res.alert.lastSeenAt).toBe(now);
    expect(res.alert.endsAt).toBe(now);
  });

  it("opens a fresh row when the window has lapsed", async () => {
    // The escalation test left last_seen_at at base+60s — lapse past that.
    const now = 1_700_000_000_000 + 60_000 + WINDOW + 1;
    const res = await store.insertDedup(TENANT, input(), WINDOW, now);
    expect(res.deduped).toBe(false);
    expect(res.alert.dedupCount).toBe(1);
  });

  it("keeps tenants isolated", async () => {
    const now = 1_700_000_000_000;
    const other = await store.insertDedup(OTHER, input(), WINDOW, now);
    expect(other.deduped).toBe(false);
  });
});

describe("claimNew — multi-replica safety", () => {
  it("claims exclusively: a second store over the same DB gets nothing", async () => {
    const now = 1_700_000_100_000;
    await store.insertDedup(TENANT, input({ fingerprint: "fp_claim" }), WINDOW, now);
    const replicaB = new SqlAiopsAlertStore({ sql: testDb!.sql });
    const a = await store.claimNew(10, now);
    const b = await replicaB.claimNew(10, now);
    expect(a.map((x) => x.fingerprint)).toContain("fp_claim");
    expect(b).toHaveLength(0);
    for (const alert of a) {
      if (alert.fingerprint === "fp_claim") expect(alert.status).toBe("dispatching");
    }
  });
});

describe("lifecycle", () => {
  it("attachSession → getOpenByFingerprint → markResolved", async () => {
    const now = 1_700_000_200_000;
    const { alert } = await store.insertDedup(
      TENANT,
      input({ fingerprint: "fp_life" }),
      WINDOW,
      now,
    );
    await store.attachSession(alert.id, "sess_1");
    const open = await store.getOpenByFingerprint(TENANT, "fp_life");
    expect(open?.sessionId).toBe("sess_1");
    expect(open?.status).toBe("dispatched");
    await store.markResolved(alert.id, now + 1000);
    const closed = await store.get(alert.id);
    expect(closed?.status).toBe("resolved");
    expect(await store.getOpenByFingerprint(TENANT, "fp_life")).toBeNull();
  });

  it("attachError records the failure for visibility", async () => {
    const now = 1_700_000_300_000;
    const { alert } = await store.insertDedup(
      TENANT,
      input({ fingerprint: "fp_err" }),
      WINDOW,
      now,
    );
    await store.claimNew(10, now);
    await store.attachError(alert.id, "triage agent not configured");
    const row = await store.get(alert.id);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("not configured");
  });

  it("listForTenant scopes by tenant and filters by severity", async () => {
    const now = 1_700_000_400_000;
    await store.insertDedup(
      TENANT,
      input({ fingerprint: "fp_list", severity: "critical" }),
      WINDOW,
      now,
    );
    const mine = await store.listForTenant(TENANT, { severity: "critical" });
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((a) => a.tenantId === TENANT && a.severity === "critical")).toBe(true);
    const otherTenant = await store.listForTenant(OTHER, {});
    expect(otherTenant.every((a) => a.tenantId === OTHER)).toBe(true);
  });
});
