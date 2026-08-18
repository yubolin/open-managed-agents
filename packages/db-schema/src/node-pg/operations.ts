// Operations Workspace tables (Node self-host PG variant).
//
// PG-typed mirror of cf-auth/operations.ts — BIGINT (mode: number) for
// epoch-ms timestamps and counters, text otherwise. The constraint shape
// (composite UNIQUE, composite FKs with tenant_id, CHECK constraints, MATCH
// SIMPLE nullable FK) is identical to the SQLite variant; see that file for
// the design rationale.
//
// PG enforces FKs unconditionally (SQLite prod runs foreign_keys=OFF), so PG
// is the authoritative enforcer in self-host deployments that use Postgres.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

// sse_tickets (Base F3) ------------------------------------------------------
// BFF auth infra for the SSE triple-gate — NOT operations domain data.
// PG-typed mirror of cf-auth/operations.ts sse_tickets; see that file for
// the cross-replica single-use rationale. No FK by design.
export const sse_tickets = pgTable(
  "sse_tickets",
  {
    token: text("token").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    run_id: text("run_id"),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_sse_tickets_expires").on(t.expires_at)],
);

// service_templates ---------------------------------------------------------
export const service_templates = pgTable(
  "service_templates",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    is_active: bigint("is_active", { mode: "number" }).notNull().default(1),
    current_version_id: text("current_version_id"),
    created_by: text("created_by").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
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
export const service_template_versions = pgTable(
  "service_template_versions",
  {
    id: text("id").primaryKey().notNull(),
    template_id: text("template_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    is_active: bigint("is_active", { mode: "number" }).notNull().default(1),
    // JSON blobs — parsed in the adapter / service layer.
    agent_binding: text("agent_binding").notNull(),
    form_schema: text("form_schema").notNull(),
    ui_schema: text("ui_schema"),
    approval_policy: text("approval_policy").notNull(),
    timeout_policy: text("timeout_policy").notNull(),
    changelog: text("changelog"),
    published_by: text("published_by").notNull(),
    published_at: bigint("published_at", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("uq_template_versions_template_version").on(
      t.template_id,
      t.version,
    ),
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
export const runs = pgTable(
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
    current_approval_stage: bigint("current_approval_stage", {
      mode: "number",
    })
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
    submitted_at: bigint("submitted_at", { mode: "number" }),
    planned_at: bigint("planned_at", { mode: "number" }),
    approved_at: bigint("approved_at", { mode: "number" }),
    started_at: bigint("started_at", { mode: "number" }),
    finished_at: bigint("finished_at", { mode: "number" }),
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
export const run_approvals = pgTable(
  "run_approvals",
  {
    id: text("id").primaryKey().notNull(),
    run_id: text("run_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    stage_order: bigint("stage_order", { mode: "number" }).notNull(),
    approver_id: text("approver_id").notNull(),
    decision: text("decision").notNull(),
    comment: text("comment"),
    plan_hash_at_decision: text("plan_hash_at_decision").notNull(),
    evidence_snapshot_hash_at_decision: text(
      "evidence_snapshot_hash_at_decision",
    ).notNull(),
    is_invalidated: bigint("is_invalidated", { mode: "number" })
      .notNull()
      .default(0),
    invalidated_reason: text("invalidated_reason"),
    invalidated_at: bigint("invalidated_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
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
export const run_artifacts = pgTable(
  "run_artifacts",
  {
    id: text("id").primaryKey().notNull(),
    run_id: text("run_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    type: text("type").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    content: text("content").notNull(),
    content_sha256: text("content_sha256").notNull(),
    // JSON: structured metadata including K3 knowledge_citations.
    metadata: text("metadata"),
    created_by: text("created_by").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
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
export const run_events = pgTable(
  "run_events",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
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
    // JSON: extensible payload.
    payload: text("payload"),
    duration_ms: bigint("duration_ms", { mode: "number" }),
    trace_id: text("trace_id").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [
    // MATCH SIMPLE composite FK, NO ACTION on parent delete — see the
    // cf-auth variant for the SET NULL / NOT NULL rationale (v0.4.2).
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
