// OperationsStreamHubPort backed by Postgres LISTEN/NOTIFY (Base F3).
//
// Same transport pattern as pg-event-stream-hub.ts (one shared channel,
// local fanout first, NOTIFY for cross-replica), adapted to the
// operations fanout matrix (tenantId × runId) with two deliberate
// differences from the session hub:
//
//   1. NO gap recovery. The session hub watermarks seq and refetches from
//      session_events after a LISTEN socket drop. Operations frames have
//      no seq and no event log — by contract the SSE stream is a
//      NOTIFICATION layer, never the source of truth; clients reconcile
//      via REST (GET /runs/:id) and F6 re-ticket reconnect is the
//      recovery path. Frames emitted while a LISTEN socket is down are
//      simply gone, like any other dropped push.
//   2. Echo filtering by origin id. Without a seq watermark the
//      originating replica cannot short-circuit its own NOTIFY echo by
//      watermark — every payload carries the publishing hub's random
//      origin id instead, and the LISTEN callback skips its own.
//
// NOTIFY payload limit is 8000 bytes; frames whose JSON exceeds
// LOCAL_ONLY_LIMIT are fanned out locally with a warn and NOT notified
// (other replicas miss that one frame — same notification-layer
// semantics as above).

import { getLogger } from "@open-managed-agents/observability";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";
import type { OperationsStreamHubPort } from "@open-managed-agents/operations-store";

const log = getLogger("pg-ops-hub");

const CHANNEL = "oma_operations_events";
// PG NOTIFY payload cap is 8000 bytes; leave headroom for the envelope.
const LOCAL_ONLY_LIMIT = 7_500;

interface PgQueryResult extends Array<Record<string, unknown>> {
  count?: number;
}
interface PgListenHandle {
  unlisten: () => Promise<void>;
}
/** Minimal postgres.js surface this hub needs — injectable for tests. */
export interface PgNotifyTransport {
  listen(
    channel: string,
    onPayload: (payload: string) => void,
    onListen?: () => void,
  ): Promise<PgListenHandle>;
  notify(channel: string, payload: string): Promise<unknown>;
  end?(opts?: { timeout?: number }): Promise<void>;
}

export interface PgOperationsStreamHubOptions {
  dsn?: string;
  transport?: PgNotifyTransport;
}

export class PgOperationsStreamHub implements OperationsStreamHubPort {
  private readonly subscribers = new Map<string, Set<(e: WorkspaceStreamEvent) => void>>();
  private readonly origin = `oph_${Math.random().toString(36).slice(2, 10)}`;
  private readonly transport: PgNotifyTransport;
  private listenHandle: PgListenHandle | null = null;
  private readonly ownedClients: Array<{ end?(opts?: { timeout?: number }): Promise<void> }> = [];

  private constructor(
    transport: PgNotifyTransport,
    listenHandle: PgListenHandle | null,
    ownedClients: Array<{ end?(opts?: { timeout?: number }): Promise<void> }>,
  ) {
    this.transport = transport;
    this.listenHandle = listenHandle;
    this.ownedClients = ownedClients;
  }

  static async create(opts: PgOperationsStreamHubOptions): Promise<PgOperationsStreamHub> {
    if (!opts.dsn === !opts.transport) {
      throw new Error("PgOperationsStreamHub.create: exactly one of dsn | transport");
    }
    if (opts.transport) {
      const hub = new PgOperationsStreamHub(opts.transport, null, []);
      const handle = await opts.transport.listen(CHANNEL, (p) => hub.onNotify(p));
      hub.bind(handle);
      return hub;
    }
    type PgFactory = (dsn: string, opts?: unknown) => PgNotifyTransport;
    const mod = (await import(/* @vite-ignore */ "postgres" as string)) as {
      default: PgFactory;
    };
    // Mirror pg-event-stream-hub: LISTEN pinned to a single backend
    // connection (max:1); NOTIFY on its own small pool so bursts cannot
    // starve the LISTEN reconnect path.
    const listenSql = mod.default(opts.dsn!, { max: 1 });
    const notifySql = mod.default(opts.dsn!, { max: 2 });
    const hub = new PgOperationsStreamHub(listenSql, null, [listenSql, notifySql]);
    const handle = await listenSql.listen(CHANNEL, (payload) => hub.onNotify(payload));
    hub.bind(handle);
    return hub;
  }

  /** Bind the LISTEN handle post-construction (private: create() only). */
  private bind(handle: PgListenHandle): void {
    this.listenHandle = handle;
  }

  private onNotify(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as {
        o: string;
        k: string;
        e: WorkspaceStreamEvent;
      };
      // Echo filter: our own publish already fanned out locally.
      if (parsed.o === this.origin) return;
      this.localFanout(parsed.k, parsed.e);
    } catch (err) {
      log.warn({ err, op: "pg_ops_hub.bad_payload" }, "dropped malformed NOTIFY payload");
    }
  }

  private localFanout(key: string, event: WorkspaceStreamEvent): void {
    const listeners = this.subscribers.get(key);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Best-effort delivery, same contract as the in-memory hub.
        listeners.delete(listener);
      }
    }
  }

  publish(tenantId: string, runId: string, event: WorkspaceStreamEvent): void {
    const key = `${tenantId}::${runId}`;
    // Local fanout first — the originating replica's subscribers must not
    // wait for the NOTIFY round-trip.
    this.localFanout(key, event);
    const payload = JSON.stringify({ o: this.origin, k: key, e: event });
    if (payload.length > LOCAL_ONLY_LIMIT) {
      log.warn(
        { key, bytes: payload.length, op: "pg_ops_hub.oversize_local_only" },
        "frame exceeded NOTIFY payload budget — local fanout only",
      );
      return;
    }
    void this.transport.notify(CHANNEL, payload).catch((err) => {
      log.warn({ err, op: "pg_ops_hub.notify_failed" }, "NOTIFY failed");
    });
  }

  subscribe(
    tenantId: string,
    runId: string,
    listener: (event: WorkspaceStreamEvent) => void,
  ): () => void {
    const key = `${tenantId}::${runId}`;
    let listeners = this.subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(key);
    };
  }

  getSubscriberCount(tenantId: string, runId: string): number {
    return this.subscribers.get(`${tenantId}::${runId}`)?.size ?? 0;
  }

  async stop(): Promise<void> {
    if (this.listenHandle) await this.listenHandle.unlisten().catch(() => undefined);
    for (const client of this.ownedClients) {
      await client.end?.({ timeout: 5 }).catch(() => undefined);
    }
  }
}
