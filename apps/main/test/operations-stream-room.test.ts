// F3 P2-② — real-DO proof of OperationsStreamRoom & CfOperationsStreamHub.
// Runs in workerd via the root vitest pool-workers configuration.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { CfOperationsStreamHub } from "@open-managed-agents/operations-store";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

describe("OperationsStreamRoom DO · real DO (workerd)", () => {
  const roomNamespace = (env as any).OPERATIONS_STREAM_ROOM as DurableObjectNamespace;

  it("do-1: handles SSE stream lifecycle with connected event", async () => {
    const runId = `run_do_test_${Date.now()}`;
    const tenantId = "tenant_test";
    const id = roomNamespace.idFromName(`${tenantId}::${runId}`);
    const stub = roomNamespace.get(id);

    const res = await stub.fetch("https://operations-stream-room/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame should be the connected event
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = decoder.decode(value);
    expect(chunk).toContain("event: connected");
    expect(chunk).toContain('"status":"connected"');

    await reader.cancel();
  });

  it("do-2: publish endpoint broadcasts frames to active SSE subscriber", async () => {
    const runId = `run_broadcast_${Date.now()}`;
    const tenantId = "tenant_broadcast";
    const id = roomNamespace.idFromName(`${tenantId}::${runId}`);
    const stub = roomNamespace.get(id);

    const streamRes = await stub.fetch("https://operations-stream-room/stream");
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    // Consume the initial connected frame
    await reader.read();

    const sampleEvent: WorkspaceStreamEvent = {
      event_type: "run.state_changed",
      tenant_id: tenantId,
      run_id: runId,
      timestamp: Date.now(),
      payload: { from: "draft", to: "submitted" },
    };

    // Publish to the DO via HTTP
    const pubRes = await stub.fetch("https://operations-stream-room/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: sampleEvent }),
    });
    expect(pubRes.status).toBe(200);
    const pubJson = (await pubRes.json()) as { ok: boolean; subscribers: number };
    expect(pubJson.ok).toBe(true);
    expect(pubJson.subscribers).toBe(1);

    // Reader receives the broadcasted event
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = decoder.decode(value);
    expect(chunk).toContain("event: run.state_changed");
    expect(chunk).toContain('"from":"draft"');
    expect(chunk).toContain('"to":"submitted"');

    await reader.cancel();
  });

  it("do-3: multiple subscribers on the same room receive the broadcast", async () => {
    const runId = `run_multi_${Date.now()}`;
    const tenantId = "tenant_multi";
    const id = roomNamespace.idFromName(`${tenantId}::${runId}`);
    const stub = roomNamespace.get(id);

    const sub1 = await stub.fetch("https://operations-stream-room/stream");
    const sub2 = await stub.fetch("https://operations-stream-room/stream");

    const reader1 = sub1.body!.getReader();
    const reader2 = sub2.body!.getReader();
    const decoder = new TextDecoder();

    // Consume initial frames
    await reader1.read();
    await reader2.read();

    const event: WorkspaceStreamEvent = {
      event_type: "run.escalation",
      tenant_id: tenantId,
      run_id: runId,
      timestamp: Date.now(),
      payload: { action: "notify_feishu_group", at_minute: 2, delivered: true },
    };

    await stub.fetch("https://operations-stream-room/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });

    const res1 = await reader1.read();
    const res2 = await reader2.read();

    expect(decoder.decode(res1.value)).toContain("event: run.escalation");
    expect(decoder.decode(res2.value)).toContain("event: run.escalation");

    await reader1.cancel();
    await reader2.cancel();
  });

  it("do-4: CfOperationsStreamHub adapter delivers events to DO room", async () => {
    const runId = `run_hub_${Date.now()}`;
    const tenantId = "tenant_hub";
    const id = roomNamespace.idFromName(`${tenantId}::${runId}`);
    const stub = roomNamespace.get(id);

    const streamRes = await stub.fetch("https://operations-stream-room/stream");
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    // Consume initial connected frame
    await reader.read();

    const hub = new CfOperationsStreamHub(roomNamespace);
    const event: WorkspaceStreamEvent = {
      event_type: "run.step_progress",
      tenant_id: tenantId,
      run_id: runId,
      timestamp: Date.now(),
      payload: { step: 1, total: 3 },
    };

    hub.publish(tenantId, runId, event);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(decoder.decode(value)).toContain("event: run.step_progress");

    await reader.cancel();
  });

  it("do-5: stats endpoint reflects subscriber counts and room isolation", async () => {
    const runId1 = `run_stats_1_${Date.now()}`;
    const runId2 = `run_stats_2_${Date.now()}`;
    const tenantId = "tenant_stats";

    const stub1 = roomNamespace.get(roomNamespace.idFromName(`${tenantId}::${runId1}`));
    const stub2 = roomNamespace.get(roomNamespace.idFromName(`${tenantId}::${runId2}`));

    // Room 1 & Room 2 start empty
    const stats1_0 = (await (await stub1.fetch("https://operations-stream-room/stats")).json()) as {
      subscribers: number;
    };
    expect(stats1_0.subscribers).toBe(0);

    const stats2_0 = (await (await stub2.fetch("https://operations-stream-room/stats")).json()) as {
      subscribers: number;
    };
    expect(stats2_0.subscribers).toBe(0);

    // Connect first subscriber to Room 1
    const res1 = await stub1.fetch("https://operations-stream-room/stream");
    const reader1 = res1.body!.getReader();
    await reader1.read();

    const stats1_1 = (await (await stub1.fetch("https://operations-stream-room/stats")).json()) as {
      subscribers: number;
    };
    expect(stats1_1.subscribers).toBe(1);

    // Connect second subscriber to Room 1
    const res2 = await stub1.fetch("https://operations-stream-room/stream");
    const reader2 = res2.body!.getReader();
    await reader2.read();

    const stats1_2 = (await (await stub1.fetch("https://operations-stream-room/stats")).json()) as {
      subscribers: number;
    };
    expect(stats1_2.subscribers).toBe(2);

    // Room 2 remains 0 (complete room isolation)
    const stats2_check = (await (await stub2.fetch("https://operations-stream-room/stats")).json()) as {
      subscribers: number;
    };
    expect(stats2_check.subscribers).toBe(0);

    await reader1.cancel();
    await reader2.cancel();
  });
});
