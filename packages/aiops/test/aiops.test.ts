import { describe, expect, it } from "vitest";
import { computeFingerprint, withinDedupWindow } from "../src/fingerprint.js";
import { normalizeAlertPayload } from "../src/normalize/index.js";
import { InMemoryAiopsAlertStore } from "../src/test-fakes.js";
import {
  renderAlertOccurrenceSignal,
  renderAlertSignal,
} from "../src/signal.js";

const NOW = 1_780_000_000_000;

describe("computeFingerprint", () => {
  it("is stable across label key order and ignores volatile labels", () => {
    const a = computeFingerprint("HighCPU", { host: "n1", job: "node", extra: "x" });
    const b = computeFingerprint("HighCPU", { job: "node", host: "n1", other: "y" });
    expect(a).toBe(b);
  });

  it("separates different hosts", () => {
    expect(computeFingerprint("A", { host: "n1" })).not.toBe(
      computeFingerprint("A", { host: "n2" }),
    );
  });
});

describe("withinDedupWindow", () => {
  it("bounds the window inclusively", () => {
    expect(withinDedupWindow(NOW - 60_000, NOW, 60_000)).toBe(true);
    expect(withinDedupWindow(NOW - 60_001, NOW, 60_000)).toBe(false);
  });
});

describe("normalizeAlertPayload", () => {
  it("sniffs alertmanager by the alerts array and maps severity", () => {
    const body = {
      status: "firing",
      commonLabels: { alertname: "HighCPU", severity: "warning" },
      alerts: [
        {
          status: "firing",
          labels: { alertname: "HighCPU", severity: "critical", host: "n1" },
          annotations: { summary: "CPU 95%" },
          startsAt: "2026-08-14T07:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
          fingerprint: "abc123",
        },
      ],
    };
    const out = normalizeAlertPayload(body, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "alertmanager",
      fingerprint: "abc123",
      severity: "critical",
      name: "HighCPU",
      resolved: false,
      endsAt: null,
    });
  });

  it("degrades unknown alertmanager severity to info", () => {
    const out = normalizeAlertPayload(
      { alerts: [{ labels: { alertname: "X", severity: "who-knows" }, startsAt: "2026-08-14T07:00:00Z" }] },
      NOW,
    );
    expect(out[0].severity).toBe("info");
  });

  it("routes non-alertmanager payloads through the generic zod schema", () => {
    const out = normalizeAlertPayload(
      { name: "DiskFull", severity: "critical", labels: { host: "db1" } },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "generic",
      severity: "critical",
      name: "DiskFull",
      startsAt: NOW,
    });
    // fallback fingerprint is deterministic
    expect(out[0].fingerprint).toBe(computeFingerprint("DiskFull", { host: "db1" }));
  });

  it("throws ZodError on malformed generic payloads", () => {
    expect(() => normalizeAlertPayload({ nope: 1 }, NOW)).toThrow();
  });
});

describe("InMemoryAiopsAlertStore", () => {
  it("dedups repeat occurrences inside the window and escalates severity", async () => {
    const store = new InMemoryAiopsAlertStore();
    const input = {
      source: "generic" as const,
      fingerprint: "f1",
      severity: "warning" as const,
      name: "A",
      labels: {},
      annotations: {},
      startsAt: NOW,
      endsAt: null,
      resolved: false,
    };
    const first = await store.insertDedup("default", input, 60_000, NOW);
    expect(first.deduped).toBe(false);
    expect(first.alert.dedupCount).toBe(1);

    const second = await store.insertDedup(
      "default",
      { ...input, severity: "critical" },
      60_000,
      NOW + 30_000,
    );
    expect(second.deduped).toBe(true);
    expect(second.alert.dedupCount).toBe(2);
    expect(second.alert.severity).toBe("critical");

    // outside the window → fresh row
    const third = await store.insertDedup("default", input, 60_000, NOW + 120_000);
    expect(third.deduped).toBe(false);
  });

  it("claimNew flips status and never re-claims", async () => {
    const store = new InMemoryAiopsAlertStore();
    await store.insertDedup("default", mk("f1"), 60_000, NOW);
    await store.insertDedup("default", mk("f2"), 60_000, NOW);
    const claimed = await store.claimNew(10, NOW);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((a) => a.status === "dispatching")).toBe(true);
    expect(await store.claimNew(10, NOW)).toHaveLength(0);
  });

  it("attachSession / attachError transition the row", async () => {
    const store = new InMemoryAiopsAlertStore();
    const { alert } = await store.insertDedup("default", mk("f1"), 60_000, NOW);
    const [claimed] = await store.claimNew(1, NOW);
    await store.attachSession(claimed.id, "sess_1");
    expect((await store.get(alert.id))?.status).toBe("dispatched");
    expect((await store.get(alert.id))?.sessionId).toBe("sess_1");
    expect(await store.getOpenByFingerprint("default", "f1")).toMatchObject({
      id: alert.id,
    });
  });

  it("resolves alerts", async () => {
    const store = new InMemoryAiopsAlertStore();
    const { alert } = await store.insertDedup("default", mk("f1"), 60_000, NOW);
    await store.markResolved(alert.id, NOW + 1000);
    expect((await store.get(alert.id))?.status).toBe("resolved");
  });
});

describe("signal rendering", () => {
  it("wraps the initial signal in an oma_signal envelope", () => {
    const store = new InMemoryAiopsAlertStore();
    void store;
    const alert = {
      id: "a1",
      tenantId: "default",
      source: "generic",
      fingerprint: "f1",
      severity: "critical",
      name: "HighCPU",
      labels: { host: "n1" },
      annotations: { summary: "CPU 95%" },
      startsAt: NOW,
      endsAt: null,
      dedupCount: 1,
      lastSeenAt: NOW,
      sessionId: null,
      status: "new",
      error: null,
      createdAt: NOW,
    } as const;
    const text = renderAlertSignal(alert as never);
    expect(text).toContain('<oma_signal kind="alert_fired"');
    expect(text).toContain("HighCPU");
    expect(text).toContain("host=n1");

    const occ = renderAlertOccurrenceSignal(alert as never);
    expect(occ).toContain('kind="alert_occurrence"');
    expect(occ).toContain("第 1 次");
  });
});

function mk(fingerprint: string) {
  return {
    source: "generic" as const,
    fingerprint,
    severity: "warning" as const,
    name: `alert-${fingerprint}`,
    labels: {},
    annotations: {},
    startsAt: NOW,
    endsAt: null,
    resolved: false,
  };
}
