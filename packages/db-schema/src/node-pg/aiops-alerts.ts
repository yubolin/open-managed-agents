// AIOps alert domain tables — PostgreSQL mirror of cf-auth/aiops-alerts.ts.
//
// Same three tables, same constraint names, same partial unique index, so
// the FK=OFF trigger-mirror discipline and the schema test suite assert
// identical shapes across D1 / node-sqlite / node-pg. Column typing follows
// this package's house rule (see operations.ts): epoch-ms timestamps and
// numeric flags/counters as bigint mode "number", text otherwise.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// aiops_alert_sources (aggregate root of ingestion) ---------------------------
export const aiopsAlertSources = pgTable(
  "aiops_alert_sources",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    // Normalizer selection (spec §7).
    type: text("type").notNull(),
    // hex(sha256(webhook_token)) — token→source single-hop lookup.
    webhook_token_hash: text("webhook_token_hash").notNull(),
    // JSON: source-level severity label mapping override (spec §7.3).
    severity_mapping_json: text("severity_mapping_json").notNull().default("{}"),
    // Expiry tick threshold: firing with no re-occurrence for this long
    // (seconds) transitions to expired.
    stale_after_seconds: bigint("stale_after_seconds", { mode: "number" })
      .notNull()
      .default(86400),
    enabled: bigint("enabled", { mode: "number" }).notNull().default(1),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // FK target for aiops_alerts (tenant_id, source_id) — PG requires the
    // referenced columns to carry a UNIQUE/PK of exactly that shape.
    unique("uq_asrc_tenant_id").on(t.tenant_id, t.id),
    uniqueIndex("uq_asrc_token").on(t.webhook_token_hash),
    index("idx_asrc_tenant").on(t.tenant_id),
    check("ck_asrc_type", sql`"type" IN ('alertmanager','generic')`),
  ],
);

// aiops_alerts (episode aggregate) ---------------------------------------------
export const aiopsAlerts = pgTable(
  "aiops_alerts",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    source_id: text("source_id").notNull(),
    // hex(sha256(canonical labels)) — computed by the normalizer (spec §5.1).
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("firing"),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    // JSON: label set of the most recent report (fingerprint input).
    labels_json: text("labels_json").notNull(),
    // JSON: annotations of the most recent report (runbook_url, description…).
    annotations_json: text("annotations_json").notNull().default("{}"),
    // Source-reported start (falls back to receive time when unparsable).
    starts_at: bigint("starts_at", { mode: "number" }).notNull(),
    last_seen_at: bigint("last_seen_at", { mode: "number" }).notNull(),
    occurrence_count: bigint("occurrence_count", { mode: "number" })
      .notNull()
      .default(1),
    resolved_at: bigint("resolved_at", { mode: "number" }),
    // SOFT reference to runs.id (latest linked run) — no FK by design.
    correlated_run_id: text("correlated_run_id"),
    // External incident / ITSM ticket passthrough (connector-ready).
    correlation_id: text("correlation_id"),
    // Required when suppressed; NULL otherwise.
    suppress_note: text("suppress_note"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // FK target for aiops_alert_events (tenant_id, alert_id).
    unique("uq_alerts_tenant_id").on(t.tenant_id, t.id),
    // Active-episode dedup anchor (spec §5.2). Partial: terminal episodes
    // free the fingerprint for a fresh row.
    uniqueIndex("uq_alerts_active_fingerprint")
      .on(t.tenant_id, t.fingerprint)
      .where(sql`"status" IN ('firing','suppressed')`),
    check(
      "ck_alerts_status",
      sql`"status" IN ('firing','resolved','suppressed','expired')`,
    ),
    check(
      "ck_alerts_severity",
      sql`"severity" IN ('critical','high','medium','low','info')`,
    ),
    // Composite FK: tenant consistency — alert belongs to a source in the
    // same tenant. NO ACTION on parent delete: a source with alerts is
    // history and must not be silently removed.
    foreignKey({
      columns: [t.tenant_id, t.source_id],
      foreignColumns: [aiopsAlertSources.tenant_id, aiopsAlertSources.id],
    }),
    index("idx_alerts_tenant_status").on(
      t.tenant_id,
      t.status,
      t.severity,
      t.last_seen_at,
    ),
    index("idx_alerts_source").on(t.tenant_id, t.source_id),
  ],
);

// aiops_alert_events (append-only audit + metrics) -----------------------------
// event_type deliberately has NO 'reopened' member: a firing after a terminal
// state is a NEW episode row (spec §5.2 / PRD 裁决 4-5). Immutability is
// enforced at the DB layer for this table (guard triggers in the migration)
// — a step beyond run_events, whose append-only is a service-layer
// discipline (spec §11 I10).
export const aiopsAlertEvents = pgTable(
  "aiops_alert_events",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    alert_id: text("alert_id").notNull(),
    event_type: text("event_type").notNull(),
    // system:ingest / system:expiry-tick / user actor (Operations AuditActor shape).
    actor: text("actor").notNull(),
    // JSON: event facts (severity before/after, run_id, note…).
    payload_json: text("payload_json").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    check(
      "ck_aev_type",
      sql`"event_type" IN ('ingested','severity_escalated','resolved','suppressed','unsuppressed','expired','run_triggered','run_completed')`,
    ),
    foreignKey({
      columns: [t.tenant_id, t.alert_id],
      foreignColumns: [aiopsAlerts.tenant_id, aiopsAlerts.id],
    }),
    index("idx_aev_alert").on(t.tenant_id, t.alert_id, t.created_at),
    index("idx_aev_type").on(t.tenant_id, t.event_type, t.created_at),
  ],
);
