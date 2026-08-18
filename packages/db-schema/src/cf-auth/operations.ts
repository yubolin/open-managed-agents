// Operations Workspace tables (CF D1 variant — packages/db-schema/src/cf-auth).
//
// These six tables back the Operations Workspace product surface:
//
//   service_templates        — tenant-scoped service catalogue entries.
//                              current_version_id points to the active
//                              published version; is_active gates catalogue
//                              visibility.
//   service_template_versions— immutable published versions. Once written,
//                              rows are never updated (Append-Only). Each
//                              version carries the full frozen config:
//                              agent_binding, form_schema, approval_policy,
//                              timeout_policy.
//   runs                     — the aggregate root. Owns tenant_id and the
//                              full state-machine lifecycle (PRD v0.5 §6).
//                              UNIQUE(tenant_id, id) is the FK target for
//                              all child tables.
//   run_approvals            — per-stage approval decisions. Composite FK
//                              (tenant_id, run_id) → runs. stage_order
//                              tracks multi-stage sequential approval (N1).
//   run_artifacts            — Append-Only immutable plan / evidence / log
//                              snapshots. UNIQUE(tenant_id, run_id, type,
//                              version) enforces monotonic version numbering.
//   run_events               — D0 unified audit envelope (§5 three-phase).
//                              run_id is NULLABLE (MATCH SIMPLE): template-
//                              level events (template.publish, archive) have
//                              run_id = NULL.
//
// Tenant isolation: every child table carries tenant_id and a composite FK
// back to runs(tenant_id, id). All queries MUST inject tenant_id from a
// trusted context.
//
// FK enforcement policy per store (repo evidence, 2026-08-17):
//   node-sqlite — prod runs PRAGMA foreign_keys = OFF
//     (apps/main-node/src/index.ts), so migrations-sqlite carries
//     hand-written trigger mirrors for every declarative-FK semantic —
//     the feishu-ops 0002 precedent. The triggers live in the migration
//     file, not here (drizzle cannot model them).
//   D1 — enforcement default is disputed: Cloudflare docs state D1
//     enforces foreign keys in all queries and migrations, but the repo's
//     sql-client adapter records the opposite empirical claim
//     (better-sqlite3.ts:150-154 — children-before-parents installs
//     succeeded on D1). The D1 migration carries the SAME trigger mirror —
//     redundant under enforcement, load-bearing without it (zero-regret,
//     spec v0.4.3 §8-4).
//   node-pg — enforces unconditionally: declarative only.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// sse_tickets (Base F3) ------------------------------------------------------
// BFF auth infra for the SSE triple-gate — NOT operations domain data. Lives
// in the consolidated baseline so multi-replica deployments share one ticket
// truth: replica A mints, replica B consumes. Single-use is enforced by
// consume-as-DELETE-RETURNING (atomic on SQLite/D1/PG alike). No FK: tickets
// are minted before any run binding exists and are transport auth, not
// domain state (SoT for runs is the runs table, never this).
export const sse_tickets = sqliteTable(
  "sse_tickets",
  {
    token: text("token").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    // Nullable: run-less tickets are legal (stream-listing future use).
    run_id: text("run_id"),
    expires_at: integer("expires_at").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_sse_tickets_expires").on(t.expires_at)],
);

// service_templates ---------------------------------------------------------
export const service_templates = sqliteTable(
  "service_templates",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    is_active: integer("is_active").notNull().default(1),
    current_version_id: text("current_version_id"),
    created_by: text("created_by").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    unique("uq_service_templates_tenant_code").on(t.tenant_id, t.code),
    // Composite UNIQUE — FK target for service_template_versions.
    unique("uq_service_templates_tenant_id").on(t.tenant_id, t.id),
    check(
      "ck_service_templates_category",
      sql`"category" IN ('diagnostic','change_plan')`,
    ),
    index("idx_service_templates_tenant").on(t.tenant_id, t.is_active),
  ],
);

// service_template_versions (immutable) -------------------------------------
export const service_template_versions = sqliteTable(
  "service_template_versions",
  {
    id: text("id").primaryKey().notNull(),
    template_id: text("template_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    version: integer("version").notNull(),
    is_active: integer("is_active").notNull().default(1),
    // JSON blobs — parsed in the adapter / service layer.
    agent_binding: text("agent_binding").notNull(),
    form_schema: text("form_schema").notNull(),
    ui_schema: text("ui_schema"),
    approval_policy: text("approval_policy").notNull(),
    timeout_policy: text("timeout_policy").notNull(),
    changelog: text("changelog"),
    published_by: text("published_by").notNull(),
    published_at: integer("published_at").notNull(),
  },
  (t) => [
    unique("uq_template_versions_template_version").on(
      t.template_id,
      t.version,
    ),
    // Composite FK: tenant consistency — version belongs to a template in
    // the same tenant. Target is uq_service_templates_tenant_id.
    foreignKey({
      columns: [t.tenant_id, t.template_id],
      foreignColumns: [service_templates.tenant_id, service_templates.id],
    }).onDelete("cascade"),
    index("idx_template_versions_template").on(
      t.tenant_id,
      t.template_id,
      t.published_at,
    ),
  ],
);

// runs (aggregate root) -----------------------------------------------------
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    title: text("title").notNull(),
    created_by: text("created_by").notNull(),
    service_template_id: text("service_template_id").notNull(),
    template_version_id: text("template_version_id").notNull(),
    // JSON: K1 input-side frozen knowledge source list + versions.
    knowledge_refs: text("knowledge_refs"),
    // JSON: form input parameters matching the template form_schema.
    input_parameters: text("input_parameters").notNull(),
    state: text("state").notNull(),
    // N1: current sequential approval stage (1-based). Resets to 1 on
    // rework / re-planning.
    current_approval_stage: integer("current_approval_stage")
      .notNull()
      .default(1),
    // Agent session binding (populated at planning start).
    session_id: text("session_id"),
    snapshot_hash: text("snapshot_hash"),
    // K2: plan and evidence content hashes for CAS gate.
    plan_hash: text("plan_hash"),
    evidence_snapshot_id: text("evidence_snapshot_id"),
    evidence_snapshot_hash: text("evidence_snapshot_hash"),
    // Points to the current valid run_approvals row.
    active_approval_id: text("active_approval_id"),
    // SOFT reference to aiops_alerts.id when the run was triggered from an
    // alert (K4 bidirectional linkage). No FK by design — separate
    // aggregates, service-layer validated (p1-aiops-alerts-spec §11 I8).
    source_alert_id: text("source_alert_id"),
    // JSON: error context for failed / interrupted / cancelled.
    failure_reason: text("failure_reason"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    submitted_at: integer("submitted_at"),
    planned_at: integer("planned_at"),
    approved_at: integer("approved_at"),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
  },
  (t) => [
    // Composite UNIQUE — this is the FK target for child tables.
    unique("uq_runs_tenant_id").on(t.tenant_id, t.id),
    check(
      "ck_runs_state",
      sql`"state" IN ('draft','submitted','planning','awaiting_approval','approved','rejected','changes_requested','executing','succeeded','failed','interrupted','cancelled','approval_invalidated')`,
    ),
    index("idx_runs_tenant_state").on(t.tenant_id, t.state, t.created_at),
    // K4 reverse hop: alert detail → runs triggered from that alert.
    index("idx_runs_tenant_source_alert").on(t.tenant_id, t.source_alert_id),
    index("idx_runs_tenant_creator").on(
      t.tenant_id,
      t.created_by,
      t.created_at,
    ),
    index("idx_runs_session").on(t.session_id),
  ],
);

// run_approvals -------------------------------------------------------------
export const run_approvals = sqliteTable(
  "run_approvals",
  {
    id: text("id").primaryKey().notNull(),
    run_id: text("run_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    stage_order: integer("stage_order").notNull(),
    approver_id: text("approver_id").notNull(),
    decision: text("decision").notNull(),
    comment: text("comment"),
    plan_hash_at_decision: text("plan_hash_at_decision").notNull(),
    evidence_snapshot_hash_at_decision: text(
      "evidence_snapshot_hash_at_decision",
    ).notNull(),
    is_invalidated: integer("is_invalidated").notNull().default(0),
    invalidated_reason: text("invalidated_reason"),
    invalidated_at: integer("invalidated_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    // Composite FK: tenant-scoped parent reference.
    foreignKey({
      columns: [t.tenant_id, t.run_id],
      foreignColumns: [runs.tenant_id, runs.id],
    }).onDelete("cascade"),
    check(
      "ck_run_approvals_decision",
      sql`"decision" IN ('approved','rejected','changes_requested')`,
    ),
    index("idx_run_approvals_run").on(
      t.tenant_id,
      t.run_id,
      t.created_at,
    ),
    index("idx_run_approvals_approver").on(
      t.tenant_id,
      t.approver_id,
      t.created_at,
    ),
  ],
);

// run_artifacts (Append-Only, immutable) ------------------------------------
export const run_artifacts = sqliteTable(
  "run_artifacts",
  {
    id: text("id").primaryKey().notNull(),
    run_id: text("run_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    content: text("content").notNull(),
    content_sha256: text("content_sha256").notNull(),
    // JSON: structured metadata including K3 knowledge_citations.
    metadata: text("metadata"),
    created_by: text("created_by").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenant_id, t.run_id],
      foreignColumns: [runs.tenant_id, runs.id],
    }).onDelete("cascade"),
    check(
      "ck_run_artifacts_type",
      sql`"type" IN ('plan','diagnosis_evidence','execution_log')`,
    ),
    // N8: monotonic version per (run, type).
    unique("uq_run_artifacts_run_type_version").on(
      t.tenant_id,
      t.run_id,
      t.type,
      t.version,
    ),
    index("idx_run_artifacts_run").on(t.tenant_id, t.run_id),
    index("idx_run_artifacts_hash").on(t.content_sha256),
  ],
);

// run_events (D0 audit envelope, Append-Only) -------------------------------
// run_id is NULLABLE (MATCH SIMPLE): template-level events have run_id NULL.
// When run_id is non-NULL the composite FK (tenant_id, run_id) → runs is
// enforced. Under FK=OFF (node-sqlite) the migration carries a MATCH SIMPLE
// trigger: skip when run_id IS NULL, enforce existence when non-NULL.
//
// FK action is NO ACTION (not SET NULL): a composite-FK SET NULL would null
// the NOT NULL tenant_id column. Run deletion is not a P0 flow — a run
// referenced by audit events blocks the delete (feishu-ops 0002 trg_fkd
// precedent: audit children RAISE ABORT). Spec v0.4.2 erratum.
export const run_events = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // D0 §5 required: resource type + id + version.
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id").notNull(),
    resource_version: text("resource_version"),
    // Nullable: template.publish / template.archive events have no run_id.
    run_id: text("run_id"),
    // JSON: { type: "user"|"agent"|"system", id: string, name?: string }
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    phase: text("phase").notNull(),
    result: text("result").notNull(),
    from_state: text("from_state"),
    to_state: text("to_state"),
    // JSON: extensible payload. Approval decisions MUST include plan_hash
    // and evidence_snapshot_hash.
    payload: text("payload"),
    duration_ms: integer("duration_ms"),
    trace_id: text("trace_id").notNull(),
    ts: integer("ts").notNull(),
  },
  (t) => [
    // MATCH SIMPLE composite FK: skips when run_id IS NULL, enforces when
    // non-NULL. NO ACTION on parent delete — SET NULL would violate the NOT
    // NULL tenant_id (spec v0.4.2 erratum); the FK=OFF trigger mirror RAISEs.
    foreignKey({
      columns: [t.tenant_id, t.run_id],
      foreignColumns: [runs.tenant_id, runs.id],
    }),
    check(
      "ck_run_events_resource_type",
      sql`"resource_type" IN ('run','template','approval')`,
    ),
    check(
      "ck_run_events_phase",
      sql`"phase" IN ('intent','result','reconciliation')`,
    ),
    check(
      "ck_run_events_result",
      sql`"result" IN ('pending','success','failure','uncertain')`,
    ),
    index("idx_run_events_tenant_run").on(t.tenant_id, t.run_id, t.ts),
    index("idx_run_events_resource").on(
      t.tenant_id,
      t.resource_type,
      t.resource_id,
    ),
    index("idx_run_events_action").on(t.tenant_id, t.action, t.ts),
    index("idx_run_events_trace").on(t.trace_id),
    index("idx_run_events_ts").on(t.tenant_id, t.ts),
  ],
);
