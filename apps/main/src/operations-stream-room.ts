// OperationsStreamRoom — Durable Object broadcast anchor for Operations Workspace (F3 P2-②).
//
// Addressed by `idFromName(`${tenantId}::${runId}`)` so any worker isolate
// publishing an event for that run, and any client connecting an SSE stream
// for that run, always lands on the SAME single-instance broadcast room.
//
// Protocol:
//   - GET  /stream   — opens an SSE stream (`text/event-stream`), sends the initial
//                      `connected` frame, enqueues 15s keepalive heartbeats, and
//                      fans out live events until the client disconnects.
//   - POST /publish  — broadcast endpoint called by CfOperationsStreamHub (body: `{ event }`).
//                      Fans out the formatted SSE frame to all connected subscribers in the room.
//   - GET  /stats    — telemetry / test observation endpoint ({ subscribers: number }).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

interface Subscriber {
  controller: ReadableStreamDefaultController;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const MAX_QUEUED_CHUNKS = 100;

export class OperationsStreamRoom extends DurableObject<Env> {
  private subscribers = new Set<Subscriber>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/publish")) {
      try {
        const body = (await request.json()) as { event?: WorkspaceStreamEvent };
        if (!body?.event) {
          return new Response(JSON.stringify({ error: "Missing event payload", code: "BAD_REQUEST" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const activeCount = this.broadcast(body.event);
        return new Response(JSON.stringify({ ok: true, subscribers: activeCount }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message, code: "INTERNAL_ERROR" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (
      request.method === "GET" &&
      (url.pathname.endsWith("/stream") || url.pathname.endsWith("/events/stream"))
    ) {
      return this.handleStream(request);
    }

    if (request.method === "GET" && url.pathname.endsWith("/stats")) {
      return new Response(JSON.stringify({ subscribers: this.subscribers.size }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  /** Direct DO RPC broadcast method */
  async publish(event: WorkspaceStreamEvent): Promise<number> {
    return this.broadcast(event);
  }

  /** Direct DO RPC subscriber count query */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Enqueue a chunk to a subscriber, evicting and closing the subscriber if
   * its internal stream buffer accumulates backpressure beyond MAX_QUEUED_CHUNKS.
   */
  private tryEnqueue(sub: Subscriber, chunk: Uint8Array): boolean {
    try {
      if (
        sub.controller.desiredSize === null ||
        (typeof sub.controller.desiredSize === "number" && sub.controller.desiredSize < -MAX_QUEUED_CHUNKS)
      ) {
        clearInterval(sub.heartbeatTimer);
        this.subscribers.delete(sub);
        try {
          sub.controller.close();
        } catch {
          // Controller already closed
        }
        return false;
      }
      sub.controller.enqueue(chunk);
      return true;
    } catch {
      // Stream closed or broken — clean up
      clearInterval(sub.heartbeatTimer);
      this.subscribers.delete(sub);
      return false;
    }
  }

  /** Internal broadcast loop with slow/dead consumer cleanup */
  private broadcast(event: WorkspaceStreamEvent): number {
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);

    for (const sub of Array.from(this.subscribers)) {
      this.tryEnqueue(sub, chunk);
    }

    return this.subscribers.size;
  }

  private handleStream(request: Request): Response {
    const encoder = new TextEncoder();
    const tenantId = request.headers.get("x-tenant-id") ?? undefined;
    const runId = request.headers.get("x-run-id") ?? undefined;
    let subEntry: Subscriber | null = null;

    request.signal.addEventListener("abort", () => {
      if (subEntry) {
        clearInterval(subEntry.heartbeatTimer);
        this.subscribers.delete(subEntry);
      }
    });

    const stream = new ReadableStream({
      start: (controller) => {
        // 1. Initial connected event frame (with run_id / tenant_id if provided)
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({
              status: "connected",
              ...(runId ? { run_id: runId } : {}),
              ...(tenantId ? { tenant_id: tenantId } : {}),
              ts: Date.now(),
            })}\n\n`,
          ),
        );

        // 2. 15s keepalive heartbeat (also subject to backpressure eviction)
        const heartbeatTimer = setInterval(() => {
          if (subEntry) {
            this.tryEnqueue(subEntry, encoder.encode(`:heartbeat ${Date.now()}\n\n`));
          }
        }, 15000);

        subEntry = { controller, heartbeatTimer };
        this.subscribers.add(subEntry);
      },
      cancel: () => {
        if (subEntry) {
          clearInterval(subEntry.heartbeatTimer);
          this.subscribers.delete(subEntry);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}
