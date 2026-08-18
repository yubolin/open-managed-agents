// AIOps alert domain tables (CF D1 variant — packages/db-schema/src/cf-auth).
//
// Three tables back the alert side of the closed-loop AIOps story
// (docs/p1-aiops-alerts-spec.md v0.1):
//
//   aiops_alert_sources — tenant-owned webhook ingestion sources. The
//                         sha256-hashed bearer token resolves the tenant at
//                         ingest time; the plaintext token is shown exactly
//                         once (creation response) and never stored.
//   aiops_alerts        — one row per alert EPISODE. Active-episode dedup is
//                         the partial unique index (tenant_id, fingerprint)
//                         WHERE status IN ('firing','suppressed'): a firing
//                         after resolved/expired opens a NEW row, keeping
//                         per-episode MTTR history intact.
//   aiops_alert_events  — append-only audit + metric events. Storm dedup
//                         bumps counters WITHOUT writing per-occurrence
//                         events (spec §5.2 throttling).
//
// Tenant isolation: every table carries tenant_id; children reference
// parents via composite (tenant_id, ...) FKs. runs.source_alert_id is a
// deliberate SOFT reference (no FK): alerts and runs are separate
// aggregates — integrity is validated at the service layer (spec §11 I8).
//
// FK enforcement policy per store: identical to operations.ts — node-sqlite
// prod runs FK=OFF (trigger mirrors in the migration), D1 enforcement is
// disputed (same mirror, zero-regret), see operations.ts header.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// aiops_alert_sources (aggregate root of ingestion) ---------------------------
export const aiops_alert_sources = sqliteTable(
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
    stale_after_seconds: integer("stale_after_seconds").notNull().default(86400),
    enabled: integer("enabled").notNull().default(1),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    // FK target for aiops_alerts (tenant_id, source_id) — SQLite/PG require
    // the referenced columns to carry a UNIQUE of exactly that shape.
    unique("uq_asrc_tenant_id").on(t.tenant_id, t.id),
    uniqueIndex("uq_asrc_token").on(t.webhook_token_hash),
    index("idx_asrc_tenant").on(t.tenant_id),
    check("ck_asrc_type", sql`"type" IN ('alertmanager','generic')`),
  ],
);

// aiops_alerts (episode aggregate) ---------------------------------------------
export const aiops_alerts = sqliteTable(
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
    starts_at: integer("starts_at").notNull(),
    last_seen_at: integer("last_seen_at").notNull(),
    occurrence_count: integer("occurrence_count").notNull().default(1),
    resolved_at: integer("resolved_at"),
    // SOFT reference to runs.id (latest linked run) — no FK by design.
    correlated_run_id: text("correlated_run_id"),
    // External incident / ITSM ticket passthrough (connector-ready).
    correlation_id: text("correlation_id"),
    // Required when suppressed; NULL otherwise.
    suppress_note: text("suppress_note"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
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
      foreignColumns: [aiops_alert_sources.tenant_id, aiops_alert_sources.id],
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
// enforced at the DB layer for this table (UPDATE/DELETE guard triggers in
// the migrations) — a step beyond run_events, whose append-only is a
// service-layer discipline (spec §11 I10).
export const aiops_alert_events = sqliteTable(
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
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "ck_aev_type",
      sql`"event_type" IN ('ingested','severity_escalated','resolved','suppressed','unsuppressed','expired','run_triggered','run_completed')`,
    ),
    foreignKey({
      columns: [t.tenant_id, t.alert_id],
      foreignColumns: [aiops_alerts.tenant_id, aiops_alerts.id],
    }),
    index("idx_aev_alert").on(t.tenant_id, t.alert_id, t.created_at),
    index("idx_aev_type").on(t.tenant_id, t.event_type, t.created_at),
  ],
);
