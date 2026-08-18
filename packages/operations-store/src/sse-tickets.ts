// SSE ticket store port (Base F3) — cross-replica single-use tickets.
//
// The triple-gate's ticket store started life as a module-level Map in the
// BFF (fine for one process). Multi-replica deployments need one shared
// truth: replica A mints, replica B consumes. This port abstracts that
// truth; the drizzle adapter backs it with the sse_tickets table
// (consume-as-DELETE-RETURNING = atomic single-use on SQLite/D1/PG alike).
//
// TTL stays the CALLER's concern (verify rejects post-consume, exactly like
// the in-process Map did) — consume() only guarantees "at most once".

export interface SseTicketRecord {
  token: string;
  tenantId: string;
  userId: string;
  runId?: string;
  expiresAt: number;
}

export interface SseTicketStorePort {
  /** Persist a freshly minted ticket. */
  issue(record: SseTicketRecord): Promise<void>;
  /**
   * Atomically consume a ticket: DELETE + return it, or null when the
   * token never existed / was already consumed. Single-use is atomic —
   * two racing consumers (even on different replicas) see exactly one
   * winner.
   */
  consume(token: string): Promise<SseTicketRecord | null>;
  /**
   * Delete already-expired leftovers. Returns the number swept. Called
   * opportunistically (throttled) by issue paths — consumed tickets are
   * already gone, this only reaps never-redeemed ones.
   */
  sweepExpired(nowMs: number): Promise<number>;
}

// In-memory default — preserves the pre-F3 single-process semantics
// (30s TTL sweep cadence, FIFO eviction at capacity) behind the port, so
// deployments without a shared store keep today's behavior bit-for-bit.
const SWEEP_INTERVAL_MS = 30_000;

export class InMemorySseTicketStore implements SseTicketStorePort {
  private readonly entries = new Map<string, SseTicketRecord>();
  private lastSweepAt = 0;

  constructor(private readonly maxEntries = 10_000) {}

  async issue(record: SseTicketRecord): Promise<void> {
    const now = record.expiresAt; // any clock works for the cadence check
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      for (const [token, entry] of this.entries) {
        if (now > entry.expiresAt) this.entries.delete(token);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      // Map preserves insertion order; with a constant TTL the oldest is
      // closest to expiry — FIFO eviction is safe.
      for (const oldest of this.entries.keys()) {
        if (this.entries.size < this.maxEntries) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(record.token, record);
  }

  async consume(token: string): Promise<SseTicketRecord | null> {
    const entry = this.entries.get(token) ?? null;
    this.entries.delete(token);
    return entry;
  }

  async sweepExpired(nowMs: number): Promise<number> {
    let swept = 0;
    for (const [token, entry] of this.entries) {
      if (nowMs > entry.expiresAt) {
        this.entries.delete(token);
        swept++;
      }
    }
    return swept;
  }

  /** Test/telemetry observation point. */
  get size(): number {
    return this.entries.size;
  }
}
