// PgOperationsStreamHub (Base F3 Phase 1) — cross-replica operations fanout.
//
// Two suites:
//   1. ALWAYS-ON unit tests over a fake transport. The fake mimics real
//      postgres LISTEN/NOTIFY semantics: notify() delivers the payload to
//      EVERY registered listener — including the publisher itself — which
//      is exactly what makes the origin-id echo filter observable.
//   2. PG-gated (PG_TEST_URL, same gate as pg-fanout.test.ts): two real
//      hubs sharing one DSN — replica B's subscriber receives what replica
//      A publishes, and the echo never double-delivers.

import { describe, it, expect, afterEach } from "vitest";
import { PgOperationsStreamHub, type PgNotifyTransport } from "../src/lib/pg-operations-stream-hub";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const d = pgEnabled ? describe : describe.skip;

// ──────────────────────────────────────────────────────────────────────
// Fake transport: notify() fans out to every listener, publisher included.
// ──────────────────────────────────────────────────────────────────────

interface FakeHandle {
  unlisten: () => Promise<void>;
}
class FakePgTransport {
  readonly listeners = new Map<number, (payload: string) => void>();
  readonly notifyCalls: Array<{ channel: string; payload: string }> = [];
  readonly unlistenCalls: number[] = [];
  endCalls = 0;
  private nextId = 1;

  async listen(
    _channel: string,
    onPayload: (payload: string) => void,
  ): Promise<FakeHandle> {
    const id = this.nextId++;
    this.listeners.set(id, onPayload);
    return {
      unlisten: async () => {
        this.unlistenCalls.push(id);
        this.listeners.delete(id);
      },
    };
  }

  async notify(channel: string, payload: string): Promise<unknown> {
    this.notifyCalls.push({ channel, payload });
    for (const cb of this.listeners.values()) cb(payload);
    return null;
  }

  async end(): Promise<void> {
    this.endCalls++;
  }
}

function sampleEvent(state: string): WorkspaceStreamEvent {
  return {
    event_type: "run.state_changed",
    tenant_id: "tenant_hub_test",
    run_id: "run_hub_test",
    ts: Date.now(),
    data: { state },
  } as WorkspaceStreamEvent;
}

const hubs: PgOperationsStreamHub[] = [];
async function hubOn(transport: PgNotifyTransport): Promise<PgOperationsStreamHub> {
  const hub = await PgOperationsStreamHub.create({ transport });
  hubs.push(hub);
  return hub;
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
});

describe("PgOperationsStreamHub · unit (fake transport)", () => {
  it("u1: publish fans out cross-instance — B's subscriber receives A's event", async () => {
    const t1 = new FakePgTransport();
    const t2 = new FakePgTransport();
    const hubA = await hubOn(t1);
    const hubB = await hubOn(t2);

    const received: string[] = [];
    hubB.subscribe("tenant_hub_test", "run_hub_test", (e) =>
      received.push((e.data as { state: string }).state),
    );

    hubA.publish("tenant_hub_test", "run_hub_test", sampleEvent("awaiting_approval"));

    // A's notify went to A's own listener (echo) — B is a SEPARATE
    // transport, so real PG semantics need the payload relayed. Simulate
    // the server-side relay: deliver A's notify payload to B's transport.
    const payload = t1.notifyCalls[0]!.payload;
    for (const cb of t2.listeners.values()) cb(payload);

    expect(received).toEqual(["awaiting_approval"]);
  });

  it("u2: echo filter — the publishing hub never double-delivers its own NOTIFY", async () => {
    const t = new FakePgTransport();
    const hub = await hubOn(t);

    const received: string[] = [];
    hub.subscribe("tenant_hub_test", "run_hub_test", (e) =>
      received.push((e.data as { state: string }).state),
    );

    hub.publish("tenant_hub_test", "run_hub_test", sampleEvent("planning"));

    // FakePgTransport delivered the notify back to the SAME hub (real PG
    // echoes to every listener, publisher included). Local fanout already
    // ran inside publish(); the echo must be filtered by origin id.
    expect(t.notifyCalls).toHaveLength(1);
    expect(received).toEqual(["planning"]);
  });

  it("u3: tenant/run isolation — frames only reach their own (tenant, run) key", async () => {
    const tA = new FakePgTransport();
    const tB = new FakePgTransport();
    const hubA = await hubOn(tA);
    const hubB = await hubOn(tB);

    const received: string[] = [];
    hubB.subscribe("tenant_other", "run_hub_test", () => received.push("wrong-tenant"));
    hubB.subscribe("tenant_hub_test", "run_other", () => received.push("wrong-run"));
    hubB.subscribe("tenant_hub_test", "run_hub_test", () => received.push("right-key"));

    hubA.publish("tenant_hub_test", "run_hub_test", sampleEvent("executing"));
    const payload = tA.notifyCalls[0]!.payload;
    for (const cb of tB.listeners.values()) cb(payload);

    expect(received).toEqual(["right-key"]);
  });

  it("u4: oversize frame degrades to local-only — no NOTIFY issued", async () => {
    const t = new FakePgTransport();
    const hub = await hubOn(t);

    const received: number[] = [];
    hub.subscribe("tenant_hub_test", "run_hub_test", (e) =>
      received.push((e.data as { bytes: number }).bytes),
    );

    const bigEvent = {
      ...sampleEvent("executing"),
      data: { bytes: 8_000, blob: "x".repeat(8_000) },
    } as WorkspaceStreamEvent;
    hub.publish("tenant_hub_test", "run_hub_test", bigEvent);

    expect(t.notifyCalls).toHaveLength(0); // over the 7.5k budget → local only
    expect(received).toEqual([8_000]); // local subscriber still served
  });

  it("u5: subscribe/unsubscribe lifecycle + getSubscriberCount", async () => {
    const hub = await hubOn(new FakePgTransport());
    expect(hub.getSubscriberCount("tenant_hub_test", "run_hub_test")).toBe(0);
    const off = hub.subscribe("tenant_hub_test", "run_hub_test", () => {});
    expect(hub.getSubscriberCount("tenant_hub_test", "run_hub_test")).toBe(1);
    off();
    expect(hub.getSubscriberCount("tenant_hub_test", "run_hub_test")).toBe(0);
  });

  it("u6: stop() unlistens and ends owned clients; create() rejects dsn+transport ambiguity", async () => {
    const t = new FakePgTransport();
    const hub = await hubOn(t);
    await hub.stop();
    expect(t.unlistenCalls).toHaveLength(1);
    // Injected transports are NOT owned — no end() from the hub.
    expect(t.endCalls).toBe(0);

    await expect(PgOperationsStreamHub.create({})).rejects.toThrow();
    await expect(
      PgOperationsStreamHub.create({ dsn: "postgres://x", transport: t as unknown as PgNotifyTransport }),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Real PG — dual hub over one DSN (gate: PG_TEST_URL).
// ──────────────────────────────────────────────────────────────────────

d("PgOperationsStreamHub · real PG dual-hub", () => {
  it("p1: replica A publish → replica B subscriber, no echo double-delivery", async () => {
    const hubA = await PgOperationsStreamHub.create({ dsn: PG_URL });
    const hubB = await PgOperationsStreamHub.create({ dsn: PG_URL });
    try {
      const tenantId = `tenant_pgoph_${Date.now()}`;
      const runId = `run_pgoph_${Date.now()}`;
      const received: string[] = [];

      const off = hubB.subscribe(tenantId, runId, (e) =>
        received.push((e.data as { state: string }).state),
      );
      // Let LISTEN registrations settle.
      await new Promise((r) => setTimeout(r, 150));

      hubA.publish(tenantId, runId, sampleEvent("awaiting_approval"));
      hubA.publish(tenantId, runId, sampleEvent("cancelled"));

      const deadline = Date.now() + 3_000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      off();

      expect(received).toEqual(["awaiting_approval", "cancelled"]);
    } finally {
      await hubA.stop();
      await hubB.stop();
    }
  });
});
