// AIOps alert tables — Node-PG variant.
//
// Structurally identical to packages/db-schema/src/node-sqlite/aiops.ts
// (PG-typed columns). See that file for the design notes: one row per open
// fingerprint, dedup via UPDATE, session_id as a no-FK audit snapshot,
// claimNew as a conditional UPDATE on status.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export const aiops_alerts = pgTable(
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
    starts_at: bigint("starts_at", { mode: "number" }).notNull(),
    ends_at: bigint("ends_at", { mode: "number" }),
    dedup_count: integer("dedup_count").notNull().default(1),
    last_seen_at: bigint("last_seen_at", { mode: "number" }).notNull(),
    // TEXT snapshot, no FK — audit survives session deletion.
    session_id: text("session_id"),
    status: text("status").notNull(),
    error: text("error"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
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
    index("idx_aiops_alerts_fingerprint").on(
      t.tenant_id,
      t.fingerprint,
      t.status,
    ),
    index("idx_aiops_alerts_status_created").on(t.status, t.created_at),
  ],
);
