// AiopsAlertStore port — persistence contract for the alert table.
//
// Implementations: packages/aiops/src/test-fakes.ts (in-memory) and the SQL
// adapters in apps/main-node (drizzle over the shared SqlClient). The port
// mirrors the recordIfNew/attachSession/attachError discipline of
// integrations-core's WebhookEventStore, plus the fingerprint lifecycle that
// table deliberately doesn't have (see the AIOps plan: reuse the patterns,
// not the table — webhook_events retention would purge the audit trail).
//
// Multi-replica safety: claimNew is a conditional UPDATE … WHERE status='new'
// returning the claimed rows, so two sweeper ticks never dispatch the same
// alert twice (worst case: both claim disjoint sets).

import type {
  AiopsAlert,
  AiopsAlertStatus,
  AiopsSeverity,
  InsertDedupResult,
  NormalizedAlertInput,
} from "./domain.js";

export interface AlertListFilters {
  severity?: AiopsSeverity;
  status?: AiopsAlertStatus;
  limit?: number;
}

export interface AiopsAlertStore {
  /**
   * Insert an occurrence with fingerprint dedup: when an open (not
   * resolved/errored-final) alert with the same tenant+fingerprint exists and
   * its lastSeenAt is inside the dedup window, increment dedupCount +
   * lastSeenAt (+ escalate severity when the new occurrence is higher) and
   * return { deduped: true }. Otherwise insert a fresh row with status
   * "new" and return { deduped: false }.
   */
  insertDedup(
    tenantId: string,
    input: NormalizedAlertInput,
    dedupWindowMs: number,
    nowMs: number,
  ): Promise<InsertDedupResult>;

  /**
   * Atomically claim up to `limit` status="new" rows by flipping them to
   * "dispatching". Returns the claimed rows. The conditional UPDATE is what
   * makes concurrent ticks safe.
   */
  claimNew(limit: number, nowMs: number): Promise<AiopsAlert[]>;

  /** Link a claimed alert to its triage session and flip to "dispatched". */
  attachSession(alertId: string, sessionId: string): Promise<void>;

  /** Record a dispatch failure and flip to "error". */
  attachError(alertId: string, message: string): Promise<void>;

  /** Find the open alert a fingerprint maps to, for session-resume routing. */
  getOpenByFingerprint(
    tenantId: string,
    fingerprint: string,
  ): Promise<AiopsAlert | null>;

  get(alertId: string): Promise<AiopsAlert | null>;

  list(filters: AlertListFilters): Promise<AiopsAlert[]>;

  /** Flip an open alert to "resolved" (source reported recovery). */
  markResolved(alertId: string, endsAt: number): Promise<void>;
}
