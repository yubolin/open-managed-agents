// F3 P2-② — real-DO proof of OperationsStreamRoom & CfOperationsStreamHub.
// Runs in workerd via the root vitest pool-workers configuration.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { CfOperationsStreamHub } from "@open-managed-agents/operations-store";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

describe("OperationsStreamRoom DO · real DO (workerd)", () => {
  const roomNamespace = (env as unknown as {
    OPERATIONS_STREAM_ROOM: DurableObjectNamespace;
  }).OPERATIONS_STREAM_ROOM;

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

    // With explicit x-run-id / x-tenant-id headers
    const resWithHeaders = await stub.fetch("https://operations-stream-room/stream", {
      headers: {
        "x-run-id": runId,
        "x-tenant-id": tenantId,
      },
    });
    const readerWithHeaders = resWithHeaders.body!.getReader();
    const { value: valH } = await readerWithHeaders.read();
    const chunkH = decoder.decode(valH);
    expect(chunkH).toContain(`"run_id":"${runId}"`);
    expect(chunkH).toContain(`"tenant_id":"${tenantId}"`);
    await readerWithHeaders.cancel();
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

  it("do-7: M-2 backpressure eviction — stalled subscriber is closed and removed at the queue cap", async () => {
    const runId = `run_backpressure_${Date.now()}`;
    const tenantId = "tenant_backpressure";
    const stub = roomNamespace.get(roomNamespace.idFromName(`${tenantId}::${runId}`));

    // Subscribe but NEVER read: the connected frame and every broadcast chunk
    // pile up in the stream queue (count strategy, HWM=1 → desiredSize = 1 − queue).
    const streamRes = await stub.fetch("https://operations-stream-room/stream");
    expect(streamRes.status).toBe(200);

    // Flood past the cap (eviction at desiredSize < −100, i.e. ~102 queued
    // chunks incl. the connected frame). 110 publishes clears the bar safely.
    let lastCount = -1;
    for (let i = 0; i < 110; i++) {
      const pubRes = await stub.fetch("https://operations-stream-room/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: {
            event_type: "run.step_progress",
            tenant_id: tenantId,
            run_id: runId,
            timestamp: Date.now(),
            payload: { step: i, total: 110 },
          } satisfies WorkspaceStreamEvent,
        }),
      });
      const json = (await pubRes.json()) as { subscribers: number };
      lastCount = json.subscribers;
    }

    // Evicted mid-flood: the room no longer counts the stalled subscriber.
    expect(lastCount).toBe(0);
    const stats = (await (
      await stub.fetch("https://operations-stream-room/stats")
    ).json()) as { subscribers: number };
    expect(stats.subscribers).toBe(0);

    // Eviction CLOSES the stream: buffered chunks drain, then `done` arrives —
    // which is exactly what flips the client EventSource to onerror → F6 re-ticket.
    const reader = streamRes.body!.getReader();
    let done = false;
    for (let reads = 0; reads < 200 && !done; reads++) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
  });

  it("do-6: hub with waitUntil anchors the DO publish to the event context (H-1)", async () => {
    const runId = `run_waituntil_${Date.now()}`;
    const tenantId = "tenant_waituntil";

    // Stand-in for c.executionCtx.waitUntil — captures the promises the
    // hub asks the runtime to keep alive past the response.
    const anchored: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => {
      anchored.push(p);
    };

    const hub = new CfOperationsStreamHub(roomNamespace, waitUntil);

    // No subscribers: publish must STILL route through waitUntil — an
    // in-flight /publish that wakes the DO is exactly the subrequest the
    // runtime would cancel without anchoring.
    hub.publish(tenantId, runId, {
      event_type: "run.escalation",
      tenant_id: tenantId,
      run_id: runId,
      timestamp: Date.now(),
      payload: { action: "notify_feishu_group", at_minute: 2, delivered: true },
    });
    expect(anchored.length).toBe(1);

    // The anchored promise settles (delivery attempted), never rejects —
    // best-effort semantics hold under waitUntil.
    await anchored[0];

    // End-to-end: a subscribed room receives the anchored publish.
    const stub = roomNamespace.get(roomNamespace.idFromName(`${tenantId}::${runId}`));
    const streamRes = await stub.fetch("https://operations-stream-room/stream");
    const reader = streamRes.body!.getReader();
    await reader.read(); // connected frame

    hub.publish(tenantId, runId, {
      event_type: "run.state_changed",
      tenant_id: tenantId,
      run_id: runId,
      timestamp: Date.now(),
      payload: { from: "awaiting_approval", to: "approved" },
    });
    expect(anchored.length).toBe(2);
    await anchored[1];

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain("event: run.state_changed");

    await reader.cancel();
  });
});
