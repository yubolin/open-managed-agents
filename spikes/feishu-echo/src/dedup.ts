// In-memory message_id dedup. Feishu may redeliver events on reconnect or
// retry; production persists these, but for the spike an LRU+TTL set is enough
// to validate the dedup path end-to-end.

export interface Deduper {
  /** Returns true if `id` was already seen, false (and records it) otherwise. */
  seen(id: string): boolean;
}

export function createMessageDeduper(opts: { max?: number; ttlMs?: number } = {}): Deduper {
  const max = opts.max ?? 1000;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const seen = new Map<string, number>();

  const evictExpired = (now: number): void => {
    if (seen.size <= max) return;
    for (const [k, ts] of seen) {
      if (now - ts > ttlMs) seen.delete(k);
    }
  };

  return {
    seen(id: string): boolean {
      const now = Date.now();
      evictExpired(now);
      if (seen.has(id)) return true;
      seen.set(id, now);
      if (seen.size > max) {
        // Drop the oldest entry when over capacity.
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, ts] of seen) {
          if (ts < oldestTs) {
            oldestTs = ts;
            oldestKey = k;
          }
        }
        if (oldestKey) seen.delete(oldestKey);
      }
      return false;
    },
  };
}
