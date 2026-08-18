// Drizzle SQL Adapter for Operations Workspace Store across D1 / SQLite / PG.

import { and, asc, desc, eq } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import {
  run_approvals,
  run_artifacts,
  run_events,
  runs,
  service_template_versions,
  service_templates,
} from "@open-managed-agents/db-schema/cf-auth";
import type { ListRunsOptions, OperationsStorePort } from "../ports";
import type {
  RunApprovalRow,
  RunArtifactRow,
  RunEventRow,
  RunRow,
  RunState,
  ServiceTemplateRow,
  ServiceTemplateVersionRow,
} from "../types";

export class DrizzleOperationsStore implements OperationsStorePort {
  private readonly db: OmaDbBuilder;
  private readonly rawDb: OmaDb;

  constructor(db: OmaDb) {
    this.rawDb = db;
    this.db = asBuilder(db);
  }

  // --------------------------------------------------------------------------
  // Service Templates
  // --------------------------------------------------------------------------

  async getTemplate(tenantId: string, templateId: string): Promise<ServiceTemplateRow | null> {
    const q = this.db
      .select()
      .from(service_templates)
      .where(and(eq(service_templates.tenant_id, tenantId), eq(service_templates.id, templateId)));
    const row = await getOne(q);
    return (row as unknown as ServiceTemplateRow) ?? null;
  }

  async getTemplateByCode(tenantId: string, code: string): Promise<ServiceTemplateRow | null> {
    const q = this.db
      .select()
      .from(service_templates)
      .where(and(eq(service_templates.tenant_id, tenantId), eq(service_templates.code, code)));
    const row = await getOne(q);
    return (row as unknown as ServiceTemplateRow) ?? null;
  }

  async listTemplates(
    tenantId: string,
    category?: string,
    onlyActive = true
  ): Promise<ServiceTemplateRow[]> {
    const conditions = [eq(service_templates.tenant_id, tenantId)];
    if (onlyActive) {
      conditions.push(eq(service_templates.is_active, 1));
    }
    if (category) {
      conditions.push(eq(service_templates.category, category));
    }

    const q = this.db
      .select()
      .from(service_templates)
      .where(and(...conditions))
      .orderBy(desc(service_templates.created_at));
    const rows = await getAll(q);
    return rows as unknown as ServiceTemplateRow[];
  }

  async getTemplateVersion(
    tenantId: string,
    versionId: string
  ): Promise<ServiceTemplateVersionRow | null> {
    const q = this.db
      .select()
      .from(service_template_versions)
      .where(
        and(
          eq(service_template_versions.tenant_id, tenantId),
          eq(service_template_versions.id, versionId)
        )
      );
    const row = await getOne(q);
    return (row as unknown as ServiceTemplateVersionRow) ?? null;
  }

  async getLatestTemplateVersion(
    tenantId: string,
    templateId: string
  ): Promise<ServiceTemplateVersionRow | null> {
    const q = this.db
      .select()
      .from(service_template_versions)
      .where(
        and(
          eq(service_template_versions.tenant_id, tenantId),
          eq(service_template_versions.template_id, templateId)
        )
      )
      .orderBy(desc(service_template_versions.version))
      .limit(1);
    const row = await getOne(q);
    return (row as unknown as ServiceTemplateVersionRow) ?? null;
  }

  async insertTemplate(
    template: ServiceTemplateRow,
    initialVersion: ServiceTemplateVersionRow
  ): Promise<void> {
    await atomicWrite(this.rawDb, [
      this.db.insert(service_templates).values({
        id: template.id,
        tenant_id: template.tenant_id,
        name: template.name,
        code: template.code,
        category: template.category,
        description: template.description,
        is_active: template.is_active,
        current_version_id: template.current_version_id,
        created_by: template.created_by,
        created_at: template.created_at,
        updated_at: template.updated_at,
      }),
      this.db.insert(service_template_versions).values({
        id: initialVersion.id,
        template_id: initialVersion.template_id,
        tenant_id: initialVersion.tenant_id,
        version: initialVersion.version,
        is_active: initialVersion.is_active,
        agent_binding: initialVersion.agent_binding,
        form_schema: initialVersion.form_schema,
        ui_schema: initialVersion.ui_schema,
        approval_policy: initialVersion.approval_policy,
        timeout_policy: initialVersion.timeout_policy,
        changelog: initialVersion.changelog,
        published_by: initialVersion.published_by,
        published_at: initialVersion.published_at,
      }),
    ]);
  }

  async insertTemplateVersion(version: ServiceTemplateVersionRow): Promise<void> {
    await runOnce(
      this.db.insert(service_template_versions).values({
        id: version.id,
        template_id: version.template_id,
        tenant_id: version.tenant_id,
        version: version.version,
        is_active: version.is_active,
        agent_binding: version.agent_binding,
        form_schema: version.form_schema,
        ui_schema: version.ui_schema,
        approval_policy: version.approval_policy,
        timeout_policy: version.timeout_policy,
        changelog: version.changelog,
        published_by: version.published_by,
        published_at: version.published_at,
      })
    );
  }

  async setTemplateVersionActive(
    tenantId: string,
    versionId: string,
    isActive: boolean
  ): Promise<void> {
    await runOnce(
      this.db
        .update(service_template_versions)
        .set({ is_active: isActive ? 1 : 0 })
        .where(
          and(
            eq(service_template_versions.tenant_id, tenantId),
            eq(service_template_versions.id, versionId)
          )
        )
    );
  }

  // --------------------------------------------------------------------------
  // Runs & CAS Transitions
  // --------------------------------------------------------------------------

  async getRun(tenantId: string, runId: string): Promise<RunRow | null> {
    const q = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.tenant_id, tenantId), eq(runs.id, runId)));
    const row = await getOne(q);
    return (row as unknown as RunRow) ?? null;
  }

  async listRuns(tenantId: string, options?: ListRunsOptions): Promise<RunRow[]> {
    const conditions = [eq(runs.tenant_id, tenantId)];
    if (options?.state) {
      conditions.push(eq(runs.state, options.state));
    }
    if (options?.createdBy) {
      conditions.push(eq(runs.created_by, options.createdBy));
    }
    if (options?.serviceTemplateId) {
      conditions.push(eq(runs.service_template_id, options.serviceTemplateId));
    }

    let query = this.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.created_at));

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset) {
      query = query.offset(options.offset) as typeof query;
    }

    const rows = await getAll(query);
    return rows as unknown as RunRow[];
  }

  async listAwaitingApprovalRunsSystem(limit: number): Promise<RunRow[]> {
    // Scheduler-only system scan (see ports.ts note) — oldest-updated first.
    const query = this.db
      .select()
      .from(runs)
      .where(eq(runs.state, "awaiting_approval"))
      .orderBy(asc(runs.updated_at))
      .limit(limit);
    const rows = await getAll(query);
    return rows as unknown as RunRow[];
  }

  async insertRun(run: RunRow): Promise<void> {
    await runOnce(
      this.db.insert(runs).values({
        id: run.id,
        tenant_id: run.tenant_id,
        title: run.title,
        created_by: run.created_by,
        service_template_id: run.service_template_id,
        template_version_id: run.template_version_id,
        knowledge_refs: run.knowledge_refs,
        input_parameters: run.input_parameters,
        state: run.state,
        current_approval_stage: run.current_approval_stage,
        session_id: run.session_id,
        snapshot_hash: run.snapshot_hash,
        plan_hash: run.plan_hash,
        evidence_snapshot_id: run.evidence_snapshot_id,
        evidence_snapshot_hash: run.evidence_snapshot_hash,
        active_approval_id: run.active_approval_id,
        failure_reason: run.failure_reason,
        created_at: run.created_at,
        updated_at: run.updated_at,
        submitted_at: run.submitted_at,
        planned_at: run.planned_at,
        approved_at: run.approved_at,
        started_at: run.started_at,
        finished_at: run.finished_at,
      })
    );
  }

  async updateRunCAS(
    tenantId: string,
    runId: string,
    fromState: RunState,
    updates: Partial<RunRow>
  ): Promise<boolean> {
    const q = this.db
      .update(runs)
      .set({
        ...updates,
        updated_at: updates.updated_at ?? Date.now(),
      })
      .where(
        and(
          eq(runs.tenant_id, tenantId),
          eq(runs.id, runId),
          eq(runs.state, fromState)
        )
      );

    let changes = 0;
    const runFn = (q as unknown as { run?: () => { changes?: number; meta?: { changes?: number } } }).run;
    if (typeof runFn === "function") {
      const res = await runFn.call(q);
      changes = res?.changes ?? res?.meta?.changes ?? 0;
    } else {
      const res = (await q) as unknown as { rowCount?: number; count?: number };
      changes = res?.rowCount ?? res?.count ?? (Array.isArray(res) ? (res as unknown[]).length : 0);
    }

    return changes > 0;
  }

  // --------------------------------------------------------------------------
  // Approvals
  // --------------------------------------------------------------------------

  async insertApproval(approval: RunApprovalRow): Promise<void> {
    await runOnce(
      this.db.insert(run_approvals).values({
        id: approval.id,
        run_id: approval.run_id,
        tenant_id: approval.tenant_id,
        stage_order: approval.stage_order,
        approver_id: approval.approver_id,
        decision: approval.decision,
        comment: approval.comment,
        plan_hash_at_decision: approval.plan_hash_at_decision,
        evidence_snapshot_hash_at_decision: approval.evidence_snapshot_hash_at_decision,
        is_invalidated: approval.is_invalidated,
        invalidated_reason: approval.invalidated_reason,
        invalidated_at: approval.invalidated_at,
        created_at: approval.created_at,
      })
    );
  }

  async listApprovals(tenantId: string, runId: string): Promise<RunApprovalRow[]> {
    const q = this.db
      .select()
      .from(run_approvals)
      .where(and(eq(run_approvals.tenant_id, tenantId), eq(run_approvals.run_id, runId)))
      .orderBy(run_approvals.created_at);
    const rows = await getAll(q);
    return rows as unknown as RunApprovalRow[];
  }

  async getActiveApproval(tenantId: string, runId: string): Promise<RunApprovalRow | null> {
    const list = await this.listApprovals(tenantId, runId);
    const approved = list.filter((a) => a.is_invalidated === 0 && a.decision === "approved");
    return approved[approved.length - 1] ?? null;
  }

  async invalidateApprovals(
    tenantId: string,
    runId: string,
    reason: string,
    now: number
  ): Promise<void> {
    await runOnce(
      this.db
        .update(run_approvals)
        .set({
          is_invalidated: 1,
          invalidated_reason: reason,
          invalidated_at: now,
        })
        .where(
          and(
            eq(run_approvals.tenant_id, tenantId),
            eq(run_approvals.run_id, runId),
            eq(run_approvals.is_invalidated, 0)
          )
        )
    );
  }

  // --------------------------------------------------------------------------
  // Artifacts (Append-Only)
  // --------------------------------------------------------------------------

  async insertArtifact(artifact: RunArtifactRow): Promise<void> {
    await runOnce(
      this.db.insert(run_artifacts).values({
        id: artifact.id,
        run_id: artifact.run_id,
        tenant_id: artifact.tenant_id,
        type: artifact.type,
        version: artifact.version,
        content: artifact.content,
        content_sha256: artifact.content_sha256,
        metadata: artifact.metadata,
        created_by: artifact.created_by,
        created_at: artifact.created_at,
      })
    );
  }

  async listArtifacts(tenantId: string, runId: string, type?: string): Promise<RunArtifactRow[]> {
    const conditions = [
      eq(run_artifacts.tenant_id, tenantId),
      eq(run_artifacts.run_id, runId),
    ];
    if (type) {
      conditions.push(eq(run_artifacts.type, type));
    }
    const q = this.db
      .select()
      .from(run_artifacts)
      .where(and(...conditions))
      .orderBy(run_artifacts.version);
    const rows = await getAll(q);
    return rows as unknown as RunArtifactRow[];
  }

  async getLatestArtifact(
    tenantId: string,
    runId: string,
    type: string
  ): Promise<RunArtifactRow | null> {
    const list = await this.listArtifacts(tenantId, runId, type);
    return list[list.length - 1] ?? null;
  }

  // --------------------------------------------------------------------------
  // D0 Audit Events (Append-Only)
  // --------------------------------------------------------------------------

  async insertEvent(event: RunEventRow): Promise<void> {
    await runOnce(
      this.db.insert(run_events).values({
        id: event.id,
        tenant_id: event.tenant_id,
        resource_type: event.resource_type,
        resource_id: event.resource_id,
        resource_version: event.resource_version,
        run_id: event.run_id,
        actor: event.actor,
        action: event.action,
        phase: event.phase,
        result: event.result,
        from_state: event.from_state,
        to_state: event.to_state,
        payload: event.payload,
        duration_ms: event.duration_ms,
        trace_id: event.trace_id,
        ts: event.ts,
      })
    );
  }

  async listEvents(tenantId: string, runId?: string, limit = 100): Promise<RunEventRow[]> {
    const conditions = [eq(run_events.tenant_id, tenantId)];
    if (runId) {
      conditions.push(eq(run_events.run_id, runId));
    }
    const q = this.db
      .select()
      .from(run_events)
      .where(and(...conditions))
      .orderBy(desc(run_events.ts))
      .limit(limit);
    const rows = await getAll(q);
    return rows as unknown as RunEventRow[];
  }

  async transaction<T>(fn: (tx: OperationsStorePort) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
