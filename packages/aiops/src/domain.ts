// AIOps alert domain — the normalized shape every alert source normalizer
// produces, plus the status/severity vocabularies shared by the store,
// the dispatch sweeper, and the console API.
//
// One AiopsAlert row per open fingerprint: repeat occurrences inside the
// dedup window increment dedup_count on the existing row instead of
// inserting new rows (see store.ts insertDedup).

/** Alert severity after source-specific mapping. Ordered for comparisons:
 *  critical > warning > info. `resolved` is carried as a status change, not
 *  a severity. */
export type AiopsSeverity = "critical" | "warning" | "info";

export const AIOPS_SEVERITY_ORDER: Record<AiopsSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/** Lifecycle of an alert row. `new` → `dispatching` (claimed by a sweeper
 *  tick) → `dispatched` (session attached) | `error`. `deduped` rows are
 *  occurrences folded into an open alert and never dispatched on their own. */
export type AiopsAlertStatus =
  | "new"
  | "dispatching"
  | "dispatched"
  | "error"
  | "deduped"
  | "resolved";

/** Sources the normalizer layer understands today. `generic` accepts any
 *  JSON payload with the documented minimal shape. */
export type AiopsAlertSource = "alertmanager" | "zabbix" | "generic";

/** Normalized alert — the unit the fingerprint, dedup window, and triage
 *  prompt rendering all operate on. */
export interface AiopsAlert {
  id: string;
  tenantId: string;
  source: AiopsAlertSource;
  /** Stable identity of the firing condition (see fingerprint.ts). One open
   *  triage session per fingerprint. */
  fingerprint: string;
  severity: AiopsSeverity;
  name: string;
  /** Free-form source labels (alert labels, Zabbix host/tags, …). Kept as a
   *  JSON string for storage; parsed at the boundaries. */
  labels: Record<string, string>;
  /** Human-facing text from the source (alert annotations, item description). */
  annotations: Record<string, string>;
  /** Epoch ms when the condition started firing (source-provided or ingest). */
  startsAt: number;
  /** Epoch ms when the source reported recovery; null while firing. */
  endsAt: number | null;
  /** Occurrences folded into this row inside the dedup window. */
  dedupCount: number;
  /** Epoch ms of the most recent occurrence. */
  lastSeenAt: number;
  /** The triage session this alert was dispatched to, once dispatched. */
  sessionId: string | null;
  status: AiopsAlertStatus;
  /** Last error message when status = "error". */
  error: string | null;
  createdAt: number;
}

/** Input produced by a normalizer — everything except the store-assigned
 *  fields (id, dedupCount, sessionId, status, createdAt, lastSeenAt). */
export interface NormalizedAlertInput {
  source: AiopsAlertSource;
  fingerprint: string;
  severity: AiopsSeverity;
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: number;
  endsAt: number | null;
  /** True when the source payload reports the condition recovered. */
  resolved: boolean;
}

/** Result of a dedup-aware insert. */
export interface InsertDedupResult {
  /** The row that carries this fingerprint after the insert. */
  alert: AiopsAlert;
  /** True when the occurrence was folded into an existing open alert
   *  (no new row, no dispatch needed). */
  deduped: boolean;
}
