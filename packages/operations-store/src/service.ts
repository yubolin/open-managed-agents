// OperationsService: Unified Domain Engine for Operations Workspace (Base B).
// Enforces: 13-state CAS transitions, Single-Transaction Approvals, SoD, CAS Double-Hash Gate, D0 3-phase Audit.

import type { OperationsStorePort } from "./ports";
import type { OperationsStreamHubPort } from "./stream";
import { globalOperationsStreamHub } from "./stream";
import type { WorkspaceStreamEventType } from "@open-managed-agents/api-types";
import type {
  ApprovalPolicy,
  AuditActor,
  AuditEventParams,
  CancelRunParams,
  CreateRunParams,
  DecideApprovalParams,
  RecordArtifactParams,
  ReworkRunParams,
  RunApprovalRow,
  RunArtifactRow,
  RunEventRow,
  RunRow,
  RunState,
  ServiceTemplateRow,
  ServiceTemplateVersionRow,
} from "./types";
import {
  AdminApprovalBypassForbiddenError,
  AuditMissingRequiredFieldError,
  EvidenceHashDriftError,
  InactiveOrInvalidTemplateVersionError,
  InvalidStateTransitionError,
  PlanHashDriftError,
  RunNotFoundError,
  RunStateConflictError,
  ServiceTemplateNotFoundError,
  SoDViolationSelfApprovalError,
} from "./errors";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export class OperationsService {
  constructor(
    private readonly store: OperationsStorePort,
    private readonly hub: OperationsStreamHubPort = globalOperationsStreamHub
  ) {}

  private notifyStreamHub(
    tenantId: string,
    runId: string,
    eventType: WorkspaceStreamEventType,
    payload: Record<string, unknown>
  ): void {
    if (!this.hub) return;
    try {
      this.hub.publish(tenantId, runId, {
        id: randomId("wev"),
        run_id: runId,
        tenant_id: tenantId,
        event_type: eventType,
        payload,
        ts: Date.now(),
      });
    } catch {
      // Best-effort: broadcast errors never fail the main transaction
    }
  }

  // --------------------------------------------------------------------------
  // Service Template Management
  // --------------------------------------------------------------------------

  async getTemplate(tenantId: string, templateId: string): Promise<ServiceTemplateRow> {
    const t = await this.store.getTemplate(tenantId, templateId);
    if (!t) throw new ServiceTemplateNotFoundError(templateId);
    return t;
  }

  async listTemplates(tenantId: string, category?: string): Promise<ServiceTemplateRow[]> {
    return this.store.listTemplates(tenantId, category, true);
  }

  async getTemplateVersion(
    tenantId: string,
    versionId: string
  ): Promise<ServiceTemplateVersionRow> {
    const v = await this.store.getTemplateVersion(tenantId, versionId);
    if (!v) throw new InactiveOrInvalidTemplateVersionError(versionId);
    return v;
  }

  // --------------------------------------------------------------------------
  // Run Lifecycle & State Machine
  // --------------------------------------------------------------------------

  async getRun(tenantId: string, runId: string): Promise<RunRow> {
    const r = await this.store.getRun(tenantId, runId);
    if (!r) throw new RunNotFoundError(runId);
    return r;
  }

  async listRuns(
    tenantId: string,
    options?: { state?: RunState; createdBy?: string; serviceTemplateId?: string; limit?: number; offset?: number }
  ): Promise<RunRow[]> {
    return this.store.listRuns(tenantId, options);
  }

  /**
   * System-level scan for the approval-timeout scheduler (Base E). Not a
   * user-facing query — see ports.listAwaitingApprovalRunsSystem.
   */
  async listAwaitingApprovalRuns(limit = 200): Promise<RunRow[]> {
    return this.store.listAwaitingApprovalRunsSystem(limit);
  }

  /**
   * Journey 1: Create Run and optionally auto-submit (K1 version snapshot).
   */
  async createRun(params: CreateRunParams): Promise<RunRow> {
    const { tenantId, templateId, templateVersionId, title, inputParameters, actor, knowledgeRefs, autoSubmit } = params;
    const now = Date.now();
    const traceId = randomId("trc");

    // 1. Resolve Template
    const template = await this.store.getTemplate(tenantId, templateId);
    if (!template || template.is_active !== 1) {
      throw new ServiceTemplateNotFoundError(templateId);
    }

    // 2. Resolve Template Version (M8-half)
    let versionRow: ServiceTemplateVersionRow | null = null;
    if (templateVersionId) {
      versionRow = await this.store.getTemplateVersion(tenantId, templateVersionId);
      if (!versionRow || versionRow.template_id !== templateId || versionRow.is_active !== 1) {
        throw new InactiveOrInvalidTemplateVersionError(templateVersionId);
      }
    } else {
      if (template.current_version_id) {
        versionRow = await this.store.getTemplateVersion(tenantId, template.current_version_id);
      }
      if (!versionRow || versionRow.is_active !== 1) {
        versionRow = await this.store.getLatestTemplateVersion(tenantId, templateId);
      }
      if (!versionRow || versionRow.is_active !== 1) {
        throw new InactiveOrInvalidTemplateVersionError("No active version found for template");
      }
    }

    const runId = randomId("run");
    const initialState: RunState = autoSubmit ? "submitted" : "draft";

    const runRow: RunRow = {
      id: runId,
      tenant_id: tenantId,
      title,
      created_by: actor.id,
      service_template_id: templateId,
      template_version_id: versionRow.id,
      knowledge_refs: knowledgeRefs ? JSON.stringify(knowledgeRefs) : null,
      input_parameters: JSON.stringify(inputParameters),
      state: initialState,
      current_approval_stage: 1,
      session_id: null,
      snapshot_hash: null,
      plan_hash: null,
      evidence_snapshot_id: null,
      evidence_snapshot_hash: null,
      active_approval_id: null,
      failure_reason: null,
      created_at: now,
      updated_at: now,
      submitted_at: autoSubmit ? now : null,
      planned_at: null,
      approved_at: null,
      started_at: null,
      finished_at: null,
    };

    await this.store.transaction(async (tx) => {
      await tx.insertRun(runRow);

      // Audit: run.create
      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.create",
        phase: "result",
        result: "success",
        toState: "draft",
        payload: { template_id: templateId, template_version_id: versionRow.id },
        traceId,
      });

      if (autoSubmit) {
        // Audit: run.submit
        await this.recordAuditEventInternal(tx, {
          tenantId,
          resourceType: "run",
          resourceId: runId,
          resourceVersion: `v${now}`,
          runId,
          actor,
          action: "run.submit",
          phase: "result",
          result: "success",
          fromState: "draft",
          toState: "submitted",
          payload: { submitted_at: now },
          traceId,
        });
      }
    });

    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: autoSubmit ? "submitted" : "draft",
      run_id: runId,
    });

    return runRow;
  }

  /**
   * Submit draft run to submitted.
   */
  async submitRun(tenantId: string, runId: string, actor: AuditActor, traceId = randomId("trc")): Promise<RunRow> {
    const run = await this.getRun(tenantId, runId);
    if (run.state !== "draft") {
      throw new InvalidStateTransitionError(run.state, "submitted");
    }

    const now = Date.now();
    await this.store.transaction(async (tx) => {
      const ok = await tx.updateRunCAS(tenantId, runId, "draft", {
        state: "submitted",
        submitted_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, "draft");

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.submit",
        phase: "result",
        result: "success",
        fromState: "draft",
        toState: "submitted",
        payload: { submitted_at: now },
        traceId,
      });
    });

    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "submitted",
      run_id: runId,
    });

    return this.getRun(tenantId, runId);
  }

  /**
   * Start planning phase: binds session_id and transitions to planning.
   */
  async startPlanning(
    tenantId: string,
    runId: string,
    sessionId: string,
    actor: AuditActor,
    snapshotHash?: string,
    traceId = randomId("trc")
  ): Promise<RunRow> {
    const run = await this.getRun(tenantId, runId);
    const validFromStates: RunState[] = ["submitted", "changes_requested", "approval_invalidated"];
    if (!validFromStates.includes(run.state)) {
      throw new InvalidStateTransitionError(run.state, "planning");
    }

    const now = Date.now();
    await this.store.transaction(async (tx) => {
      const ok = await tx.updateRunCAS(tenantId, runId, run.state, {
        state: "planning",
        session_id: sessionId,
        snapshot_hash: snapshotHash ?? run.snapshot_hash,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, run.state);

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.plan_start",
        phase: "intent",
        result: "pending",
        fromState: run.state,
        toState: "planning",
        payload: { session_id: sessionId, snapshot_hash: snapshotHash },
        traceId,
      });
    });

    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "planning",
      run_id: runId,
      session_id: sessionId,
    });

    return this.getRun(tenantId, runId);
  }

  /**
   * Complete planning phase: records plan & evidence artifacts, sets awaiting_approval.
   */
  async finishPlanning(
    tenantId: string,
    runId: string,
    planArtifact: { content: string; sha256: string },
    evidenceArtifact: { id: string; content: string; sha256: string },
    actor: AuditActor,
    durationMs?: number,
    traceId = randomId("trc")
  ): Promise<RunRow> {
    const run = await this.getRun(tenantId, runId);
    if (run.state !== "planning") {
      throw new InvalidStateTransitionError(run.state, "awaiting_approval");
    }

    const now = Date.now();
    const planArtifactId = randomId("art_plan");

    await this.store.transaction(async (tx) => {
      // 1. Insert Plan Artifact
      await tx.insertArtifact({
        id: planArtifactId,
        tenant_id: tenantId,
        run_id: runId,
        type: "plan",
        version: 1,
        content: planArtifact.content,
        content_sha256: planArtifact.sha256,
        metadata: JSON.stringify({ generator: actor.id }),
        created_by: actor.id,
        created_at: now,
      });

      // 2. Insert Evidence Artifact
      await tx.insertArtifact({
        id: evidenceArtifact.id,
        tenant_id: tenantId,
        run_id: runId,
        type: "diagnosis_evidence",
        version: 1,
        content: evidenceArtifact.content,
        content_sha256: evidenceArtifact.sha256,
        metadata: JSON.stringify({ generator: actor.id }),
        created_by: actor.id,
        created_at: now,
      });

      // 3. Update Run with Hashes and Transition to awaiting_approval
      const ok = await tx.updateRunCAS(tenantId, runId, "planning", {
        state: "awaiting_approval",
        plan_hash: planArtifact.sha256,
        evidence_snapshot_id: evidenceArtifact.id,
        evidence_snapshot_hash: evidenceArtifact.sha256,
        planned_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, "planning");

      // 4. Audit Trail
      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.plan_finish",
        phase: "result",
        result: "success",
        payload: {
          plan_hash: planArtifact.sha256,
          evidence_snapshot_hash: evidenceArtifact.sha256,
        },
        durationMs,
        traceId,
      });

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.await_approval",
        phase: "result",
        result: "success",
        fromState: "planning",
        toState: "awaiting_approval",
        payload: {
          plan_hash: planArtifact.sha256,
          current_stage: run.current_approval_stage,
        },
        traceId,
      });
    });

    this.notifyStreamHub(tenantId, runId, "run.artifact_created", {
      type: "plan",
      sha256: planArtifact.sha256,
    });
    this.notifyStreamHub(tenantId, runId, "run.approval_requested", {
      stage: run.current_approval_stage,
      plan_hash: planArtifact.sha256,
    });
    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "awaiting_approval",
      run_id: runId,
    });

    return this.getRun(tenantId, runId);
  }

  // --------------------------------------------------------------------------
  // Approval Decision & SoD Enforcement (Single Transaction)
  // --------------------------------------------------------------------------

  async decideApproval(params: DecideApprovalParams): Promise<RunRow> {
    const { tenantId, runId, actor, decision, comment, traceId = randomId("trc") } = params;
    const now = Date.now();

    const res = await this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      if (run.state !== "awaiting_approval") {
        throw new InvalidStateTransitionError(run.state, decision);
      }

      // Rule 1: SoD Hard Assertion (D0 §3: Creator !== Approver)
      if (run.created_by === actor.id) {
        throw new SoDViolationSelfApprovalError(runId, actor.id);
      }

      // Rule 2: Admin zero privilege (RBAC §1.1: Platform Admin has no business approval privilege)
      if (actor.role === "role_platform_admin") {
        throw new AdminApprovalBypassForbiddenError(actor.id);
      }

      if (!run.plan_hash || !run.evidence_snapshot_hash) {
        throw new Error(`Cannot approve run ${runId} without plan_hash and evidence_snapshot_hash`);
      }

      const approvalId = randomId("appr");
      const currentStage = run.current_approval_stage;

      if (decision === "approved") {
        // Resolve policy to determine if this is the final stage
        const version = await tx.getTemplateVersion(tenantId, run.template_version_id);
        const policy: ApprovalPolicy = version ? JSON.parse(version.approval_policy) : { mode: "sequential_groups", stages: [{ stage_order: 1, stage_name: "Default", group_id: "default", required_approvals: 1 }] };
        const totalStages = policy.stages?.length || 1;
        const isFinalStage = currentStage >= totalStages;

        const toState: RunState = isFinalStage ? "approved" : "awaiting_approval";
        const nextStage = isFinalStage ? currentStage : currentStage + 1;

        // 1. Insert Approval Record
        const approvalRow: RunApprovalRow = {
          id: approvalId,
          run_id: runId,
          tenant_id: tenantId,
          stage_order: currentStage,
          approver_id: actor.id,
          decision: "approved",
          comment: comment ?? null,
          plan_hash_at_decision: run.plan_hash,
          evidence_snapshot_hash_at_decision: run.evidence_snapshot_hash,
          is_invalidated: 0,
          invalidated_reason: null,
          invalidated_at: null,
          created_at: now,
        };
        await tx.insertApproval(approvalRow);

        // 2. CAS State Transition
        const ok = await tx.updateRunCAS(tenantId, runId, "awaiting_approval", {
          state: toState,
          current_approval_stage: nextStage,
          active_approval_id: isFinalStage ? approvalId : run.active_approval_id,
          approved_at: isFinalStage ? now : null,
          updated_at: now,
        });
        if (!ok) throw new RunStateConflictError(runId, "awaiting_approval");

        // 3. Single-Transaction D0 Audit
        await this.recordAuditEventInternal(tx, {
          tenantId,
          resourceType: "run",
          resourceId: runId,
          resourceVersion: `v${now}`,
          runId,
          actor,
          action: "approval.approve",
          phase: "result",
          result: "success",
          fromState: "awaiting_approval",
          toState,
          payload: {
            plan_hash: run.plan_hash,
            evidence_snapshot_hash: run.evidence_snapshot_hash,
            approver_id: actor.id,
            stage_order: currentStage,
            is_final_stage: isFinalStage,
            comment,
          },
          traceId,
        });
      } else if (decision === "rejected") {
        const approvalRow: RunApprovalRow = {
          id: approvalId,
          run_id: runId,
          tenant_id: tenantId,
          stage_order: currentStage,
          approver_id: actor.id,
          decision: "rejected",
          comment: comment ?? null,
          plan_hash_at_decision: run.plan_hash,
          evidence_snapshot_hash_at_decision: run.evidence_snapshot_hash,
          is_invalidated: 0,
          invalidated_reason: null,
          invalidated_at: null,
          created_at: now,
        };
        await tx.insertApproval(approvalRow);

        const ok = await tx.updateRunCAS(tenantId, runId, "awaiting_approval", {
          state: "rejected",
          failure_reason: comment ? JSON.stringify({ reason: comment }) : null,
          finished_at: now,
          updated_at: now,
        });
        if (!ok) throw new RunStateConflictError(runId, "awaiting_approval");

        await this.recordAuditEventInternal(tx, {
          tenantId,
          resourceType: "run",
          resourceId: runId,
          resourceVersion: `v${now}`,
          runId,
          actor,
          action: "approval.reject",
          phase: "result",
          result: "success",
          fromState: "awaiting_approval",
          toState: "rejected",
          payload: { approver_id: actor.id, comment, stage_order: currentStage },
          traceId,
        });
      } else if (decision === "changes_requested") {
        const approvalRow: RunApprovalRow = {
          id: approvalId,
          run_id: runId,
          tenant_id: tenantId,
          stage_order: currentStage,
          approver_id: actor.id,
          decision: "changes_requested",
          comment: comment ?? null,
          plan_hash_at_decision: run.plan_hash,
          evidence_snapshot_hash_at_decision: run.evidence_snapshot_hash,
          is_invalidated: 0,
          invalidated_reason: null,
          invalidated_at: null,
          created_at: now,
        };
        await tx.insertApproval(approvalRow);

        const ok = await tx.updateRunCAS(tenantId, runId, "awaiting_approval", {
          state: "changes_requested",
          failure_reason: comment ? JSON.stringify({ rework_comments: comment }) : null,
          updated_at: now,
        });
        if (!ok) throw new RunStateConflictError(runId, "awaiting_approval");

        await this.recordAuditEventInternal(tx, {
          tenantId,
          resourceType: "run",
          resourceId: runId,
          resourceVersion: `v${now}`,
          runId,
          actor,
          action: "approval.request_changes",
          phase: "result",
          result: "success",
          fromState: "awaiting_approval",
          toState: "changes_requested",
          payload: { approver_id: actor.id, rework_comments: comment, stage_order: currentStage },
          traceId,
        });
      }

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });

    this.notifyStreamHub(tenantId, runId, "run.approval_decided", {
      decision,
      approver_id: actor.id,
      state: res.state,
    });
    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: res.state,
      run_id: runId,
    });

    return res;
  }

  /**
   * Applicant Rework Resubmit (N1 reset stage + invalidate prior round approvals).
   */
  async reworkRun(params: ReworkRunParams): Promise<RunRow> {
    const { tenantId, runId, actor, inputParameters, comment, traceId = randomId("trc") } = params;
    const now = Date.now();

    const res = await this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      const validStates: RunState[] = ["changes_requested", "approval_invalidated"];
      if (!validStates.includes(run.state)) {
        throw new InvalidStateTransitionError(run.state, "planning");
      }

      // Invalidate all existing approvals for this round
      await tx.invalidateApprovals(tenantId, runId, "REWORK_RESUBMITTED", now);

      const ok = await tx.updateRunCAS(tenantId, runId, run.state, {
        state: "planning",
        current_approval_stage: 1,
        active_approval_id: null,
        input_parameters: inputParameters ? JSON.stringify(inputParameters) : run.input_parameters,
        failure_reason: null,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, run.state);

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.plan_start",
        phase: "intent",
        result: "pending",
        fromState: run.state,
        toState: "planning",
        payload: { rework_comment: comment, stage_reset: 1 },
        traceId,
      });

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });

    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "planning",
      run_id: runId,
    });

    return res;
  }

  // --------------------------------------------------------------------------
  // CAS Execution Gate (K2 / H1 Anti-Drift)
  // --------------------------------------------------------------------------

  async checkCASAndStartExecution(
    tenantId: string,
    runId: string,
    actor: AuditActor,
    traceId = randomId("trc")
  ): Promise<RunRow> {
    const now = Date.now();

    const res = await this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      if (run.state !== "approved") {
        throw new InvalidStateTransitionError(run.state, "executing");
      }

      const activeAppr = await tx.getActiveApproval(tenantId, runId);
      if (!activeAppr) {
        throw new Error(`Run ${runId} in state 'approved' has no active approval record`);
      }

      // Check Plan Hash Drift (K2)
      if (run.plan_hash !== activeAppr.plan_hash_at_decision) {
        await this.handleDriftInvalidation(tx, run, activeAppr, "PLAN_HASH_DRIFT", now, traceId, actor);
        throw new PlanHashDriftError(runId);
      }

      // Check Evidence Hash Drift (H1)
      if (run.evidence_snapshot_hash !== activeAppr.evidence_snapshot_hash_at_decision) {
        await this.handleDriftInvalidation(tx, run, activeAppr, "EVIDENCE_HASH_DRIFT", now, traceId, actor);
        throw new EvidenceHashDriftError(runId);
      }

      // CAS Passed -> executing
      const ok = await tx.updateRunCAS(tenantId, runId, "approved", {
        state: "executing",
        started_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, "approved");

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.exec_start",
        phase: "intent",
        result: "pending",
        fromState: "approved",
        toState: "executing",
        payload: {
          plan_hash: run.plan_hash,
          approval_id: activeAppr.id,
        },
        traceId,
      });

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });

    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "executing",
      run_id: runId,
    });

    return res;
  }

  private async handleDriftInvalidation(
    tx: OperationsStorePort,
    run: RunRow,
    appr: RunApprovalRow,
    driftReason: string,
    now: number,
    traceId: string,
    actor: AuditActor
  ): Promise<void> {
    await tx.invalidateApprovals(run.tenant_id, run.id, driftReason, now);
    await tx.updateRunCAS(run.tenant_id, run.id, run.state, {
      state: "approval_invalidated",
      active_approval_id: null,
      failure_reason: JSON.stringify({ drift_reason: driftReason }),
      updated_at: now,
    });

    await this.recordAuditEventInternal(tx, {
      tenantId: run.tenant_id,
      resourceType: "run",
      resourceId: run.id,
      resourceVersion: `v${now}`,
      runId: run.id,
      actor,
      action: "approval.invalidate",
      phase: "result",
      result: "success",
      fromState: run.state,
      toState: "approval_invalidated",
      payload: {
        invalidated_reason: driftReason,
        plan_hash: run.plan_hash,
        approval_id: appr.id,
      },
      traceId,
    });
  }

  // --------------------------------------------------------------------------
  // Cancellation & Interruption
  // --------------------------------------------------------------------------

  async cancelRun(params: CancelRunParams): Promise<RunRow> {
    const { tenantId, runId, actor, reason, traceId = randomId("trc") } = params;
    const now = Date.now();

    const res = await this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      const cancellableStates: RunState[] = ["draft", "submitted", "awaiting_approval"];
      if (!cancellableStates.includes(run.state)) {
        throw new InvalidStateTransitionError(run.state, "cancelled");
      }

      const ok = await tx.updateRunCAS(tenantId, runId, run.state, {
        state: "cancelled",
        failure_reason: reason ? JSON.stringify({ cancel_reason: reason }) : null,
        finished_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, run.state);

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.cancel",
        phase: "result",
        result: "success",
        fromState: run.state,
        toState: "cancelled",
        payload: { cancel_reason: reason },
        traceId,
      });

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });

    this.notifyStreamHub(tenantId, runId, "run.cancelled", {
      reason,
      cancelled_by: actor.id,
    });
    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "cancelled",
      run_id: runId,
    });

    return res;
  }

  async interruptRun(
    tenantId: string,
    runId: string,
    actor: AuditActor,
    reason?: string,
    traceId = randomId("trc")
  ): Promise<RunRow> {
    const now = Date.now();

    const res = await this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      if (run.state !== "executing") {
        throw new InvalidStateTransitionError(run.state, "interrupted");
      }

      const ok = await tx.updateRunCAS(tenantId, runId, "executing", {
        state: "interrupted",
        failure_reason: reason ? JSON.stringify({ interrupt_reason: reason }) : null,
        finished_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, "executing");

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.interrupt",
        phase: "result",
        result: "success",
        fromState: "executing",
        toState: "interrupted",
        payload: { operator_id: actor.id, reason },
        traceId,
      });

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });

    this.notifyStreamHub(tenantId, runId, "run.interrupted", {
      reason,
      interrupted_by: actor.id,
    });
    this.notifyStreamHub(tenantId, runId, "run.state_changed", {
      state: "interrupted",
      run_id: runId,
    });

    return res;
  }

  async finishExecution(
    tenantId: string,
    runId: string,
    success: boolean,
    actor: AuditActor,
    durationMs?: number,
    failureReason?: string,
    traceId = randomId("trc")
  ): Promise<RunRow> {
    const now = Date.now();
    const toState: RunState = success ? "succeeded" : "failed";

    return this.store.transaction(async (tx) => {
      const run = await tx.getRun(tenantId, runId);
      if (!run) throw new RunNotFoundError(runId);

      if (run.state !== "executing") {
        throw new InvalidStateTransitionError(run.state, toState);
      }

      const ok = await tx.updateRunCAS(tenantId, runId, "executing", {
        state: toState,
        failure_reason: failureReason ? JSON.stringify({ error: failureReason }) : null,
        finished_at: now,
        updated_at: now,
      });
      if (!ok) throw new RunStateConflictError(runId, "executing");

      await this.recordAuditEventInternal(tx, {
        tenantId,
        resourceType: "run",
        resourceId: runId,
        resourceVersion: `v${now}`,
        runId,
        actor,
        action: "run.exec_finish",
        phase: "result",
        result: success ? "success" : "failure",
        fromState: "executing",
        toState,
        durationMs,
        payload: { exit_status: toState, error: failureReason },
        traceId,
      });

      const updated = await tx.getRun(tenantId, runId);
      return updated!;
    });
  }

  // --------------------------------------------------------------------------
  // D0 Audit Recording
  // --------------------------------------------------------------------------

  async recordAuditEvent(params: AuditEventParams): Promise<void> {
    await this.recordAuditEventInternal(this.store, params);
  }

  private async recordAuditEventInternal(
    store: OperationsStorePort,
    params: AuditEventParams
  ): Promise<void> {
    if (!params.tenantId) throw new AuditMissingRequiredFieldError("tenant_id");
    if (!params.actor || !params.actor.id) throw new AuditMissingRequiredFieldError("actor");
    if (!params.action) throw new AuditMissingRequiredFieldError("action");

    const eventRow: RunEventRow = {
      id: randomId("revt"),
      tenant_id: params.tenantId,
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      resource_version: params.resourceVersion ?? null,
      run_id: params.runId ?? null,
      actor: JSON.stringify(params.actor),
      action: params.action,
      phase: params.phase,
      result: params.result,
      from_state: params.fromState ?? null,
      to_state: params.toState ?? null,
      payload: params.payload ? JSON.stringify(params.payload) : null,
      duration_ms: params.durationMs ?? null,
      trace_id: params.traceId || randomId("trc"),
      ts: Date.now(),
    };

    await store.insertEvent(eventRow);
  }

  async listEvents(tenantId: string, runId?: string, limit = 100): Promise<RunEventRow[]> {
    return this.store.listEvents(tenantId, runId, limit);
  }

  async listApprovals(tenantId: string, runId: string): Promise<RunApprovalRow[]> {
    return this.store.listApprovals(tenantId, runId);
  }

  async listArtifacts(tenantId: string, runId: string, type?: string): Promise<RunArtifactRow[]> {
    return this.store.listArtifacts(tenantId, runId, type);
  }
}
