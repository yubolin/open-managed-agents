// AIOps alert tables (Node self-host SQLite variant).
//
// Node-only: aiops_alerts backs the alert-triage closed loop (webhook ingest
// → fingerprint dedup → dispatch → triage session) on the main-node runtime.
// CF D1 is untouched (no AIOps ingest there), so the table lives under
// node-sqlite + node-pg dual-write like feishu-ops.ts.
//
// Design notes (see packages/aiops/src/store.ts for the port contract):
//   - One row per open fingerprint; occurrences inside the dedup window
//     UPDATE dedup_count/last_seen_at instead of inserting.
//   - session_id is a plain TEXT snapshot — deliberately NO FK to sessions(id):
//     the alert audit trail must survive session deletion (same rationale as
//     memory_confirmations.source_session_id).
//   - claimNew() is a conditional UPDATE ... WHERE status='new' — the status
//     CHECK list is exactly the lifecycle vocabulary in
//     packages/aiops/src/domain.ts.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const aiops_alerts = sqliteTable(
  "aiops_alerts",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    source: text("source").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").notNull(),
    name: text("name").notNull(),
    labels: text("labels").notNull().default("{}"),
    annotations: text("annotations").notNull().default("{}"),
    starts_at: integer("starts_at").notNull(),
    ends_at: integer("ends_at"),
    dedup_count: integer("dedup_count").notNull().default(1),
    last_seen_at: integer("last_seen_at").notNull(),
    // TEXT snapshot, no FK — audit survives session deletion.
    session_id: text("session_id"),
    status: text("status").notNull(),
    error: text("error"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "ck_aiops_alerts_status",
      sql`"status" IN ('new','dispatching','dispatched','error','deduped','resolved')`,
    ),
    check(
      "ck_aiops_alerts_severity",
      sql`"severity" IN ('critical','warning','info')`,
    ),
    // Dedup lookup: open alert by tenant+fingerprint.
    index("idx_aiops_alerts_fingerprint").on(
      t.tenant_id,
      t.fingerprint,
      t.status,
    ),
    // Sweeper claim scan + console list ordering.
    index("idx_aiops_alerts_status_created").on(t.status, t.created_at),
  ],
);
