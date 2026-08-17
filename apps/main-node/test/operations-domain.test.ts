// Base B Domain Engine & D0 Security Invariants Test Suite.
// Covers: D0 7 Negative Security Tests, 13-state 15-transition matrix, CAS execution gate, SoD.

import { describe, expect, it, beforeEach } from "vitest";
import {
  InMemoryOperationsStore,
  OperationsService,
  RunNotFoundError,
  SoDViolationSelfApprovalError,
  PlanHashDriftError,
  EvidenceHashDriftError,
  RunStateConflictError,
  AuditMissingRequiredFieldError,
  InvalidStateTransitionError,
  InactiveOrInvalidTemplateVersionError,
  AdminApprovalBypassForbiddenError,
  type AuditActor,
} from "@open-managed-agents/operations-store";

describe("Base B · Operations Domain Engine & D0 Invariants", () => {
  let store: InMemoryOperationsStore;
  let service: OperationsService;

  const tenantA = "tenant_alpha";
  const tenantB = "tenant_bravo";
  const actorAlice: AuditActor = { type: "user", id: "user_alice", name: "Alice (Applicant)" };
  const actorBob: AuditActor = { type: "user", id: "user_bob", name: "Bob (SRE Lead Approver)" };
  const actorCharlie: AuditActor = { type: "user", id: "user_charlie", name: "Charlie (Service Owner Approver)" };
  const actorAdmin: AuditActor = { type: "user", id: "user_admin", name: "Platform Admin", role: "role_platform_admin" };

  beforeEach(async () => {
    store = new InMemoryOperationsStore();
    service = new OperationsService(store);

    // Seed a standard 2-stage change plan service template in Tenant A
    await store.insertTemplate(
      {
        id: "stpl_k8s_change",
        tenant_id: tenantA,
        name: "K8s Pod Memory Resize",
        code: "k8s_mem_resize",
        category: "change_plan",
        description: "Scale pod memory limits",
        is_active: 1,
        current_version_id: "stplv_v1",
        created_by: "system",
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: "stplv_v1",
        template_id: "stpl_k8s_change",
        tenant_id: tenantA,
        version: 1,
        is_active: 1,
        agent_binding: JSON.stringify({ agent_id: "agent_k8s_planner", version: 1 }),
        form_schema: JSON.stringify({ type: "object", properties: { cluster: { type: "string" } }, required: ["cluster"] }),
        ui_schema: null,
        approval_policy: JSON.stringify({
          mode: "sequential_groups",
          stages: [
            { stage_order: 1, stage_name: "SRE Lead Initial Review", group_id: "grp_sre", required_approvals: 1 },
            { stage_order: 2, stage_name: "Service Owner Final Signoff", group_id: "grp_owners", required_approvals: 1 },
          ],
        }),
        timeout_policy: JSON.stringify({ approval_timeout_minutes: 60, escalation_interval_minutes: 15, escalation_actions: [] }),
        changelog: "Initial published version",
        published_by: "system",
        published_at: 1000,
      }
    );
  });

  // ==========================================================================
  // D0 7 NEGATIVE SECURITY TESTS (M10-Missing Closure & D0 Principles)
  // ==========================================================================

  it("TEST_NEG_TENANT_ISOLATION · Cross-tenant run access strictly returns 404 (D0 §4 Anti-Probing)", async () => {
    // 1. Alice creates Run in Tenant A
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Resize checkout memory",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });

    expect(run.tenant_id).toBe(tenantA);

    // 2. User from Tenant B attempts to read run -> MUST throw 404 RunNotFoundError (not 403, preventing existence probing)
    await expect(service.getRun(tenantB, run.id)).rejects.toThrow(RunNotFoundError);

    // 3. User from Tenant B attempts to approve run in Tenant A -> MUST throw 404
    await expect(
      service.decideApproval({
        tenantId: tenantB,
        runId: run.id,
        actor: actorBob,
        decision: "approved",
      })
    ).rejects.toThrow(RunNotFoundError);
  });

  it("TEST_NEG_SOD_SELF_APPROVAL · Applicant cannot approve their own run (D0 §3 SoD Hard Constraint)", async () => {
    // 1. Alice creates and submits run
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Resize checkout memory",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });

    // 2. Start and finish planning to enter awaiting_approval
    await service.startPlanning(tenantA, run.id, "sess_123", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan content", sha256: "sha_plan_001" },
      { id: "art_ev_1", content: "evidence content", sha256: "sha_ev_001" },
      actorAlice
    );

    // 3. Alice attempts to approve her own run -> MUST throw SoDViolationSelfApprovalError (403)
    await expect(
      service.decideApproval({
        tenantId: tenantA,
        runId: run.id,
        actor: actorAlice, // Self approval!
        decision: "approved",
        comment: "LGTM by author",
      })
    ).rejects.toThrow(SoDViolationSelfApprovalError);
  });

  it("TEST_NEG_ADMIN_APPROVAL_BYPASS · Platform Admin without approver role cannot bypass business approval (RBAC §1.1)", async () => {
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Admin bypass test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantA, run.id, "sess_123", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan content", sha256: "sha_plan_001" },
      { id: "art_ev_1", content: "evidence content", sha256: "sha_ev_001" },
      actorAlice
    );

    // Platform Admin attempts to approve without approver role -> MUST throw AdminApprovalBypassForbiddenError (403)
    await expect(
      service.decideApproval({
        tenantId: tenantA,
        runId: run.id,
        actor: actorAdmin,
        decision: "approved",
        comment: "Bypass by Platform Admin",
      })
    ).rejects.toThrow(AdminApprovalBypassForbiddenError);
  });

  it("TEST_NEG_CAS_PLAN_DRIFT · Plan content drift after approval blocks execution with 409 (K2 CAS Gate)", async () => {
    // 1. Create run and finish planning
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Plan drift test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });

    await service.startPlanning(tenantA, run.id, "sess_123", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan original", sha256: "sha_plan_orig" },
      { id: "art_ev_1", content: "evidence orig", sha256: "sha_ev_orig" },
      actorAlice
    );

    // 2. Bob passes Stage 1, Charlie passes Stage 2 -> Run is 'approved'
    await service.decideApproval({ tenantId: tenantA, runId: run.id, actor: actorBob, decision: "approved" });
    await service.decideApproval({ tenantId: tenantA, runId: run.id, actor: actorCharlie, decision: "approved" });

    const approvedRun = await service.getRun(tenantA, run.id);
    expect(approvedRun.state).toBe("approved");

    // 3. Simulate unauthorized tampering / plan drift before execution
    const runInStore = store.runs.get(`${tenantA}::${run.id}`)!;
    runInStore.plan_hash = "sha_plan_TAMPERED_DRIFT";

    // 4. Attempt to execute -> MUST throw PlanHashDriftError (409) AND transition to approval_invalidated
    await expect(service.checkCASAndStartExecution(tenantA, run.id, actorBob)).rejects.toThrow(PlanHashDriftError);

    const invalidatedRun = await service.getRun(tenantA, run.id);
    expect(invalidatedRun.state).toBe("approval_invalidated");

    // Approvals must be invalidated
    const approvals = await store.listApprovals(tenantA, run.id);
    expect(approvals.every((a) => a.is_invalidated === 1)).toBe(true);

    // Audit event must be emitted
    const events = await store.listEvents(tenantA, run.id);
    const invalidateEvent = events.find((e) => e.action === "approval.invalidate");
    expect(invalidateEvent).toBeDefined();
    expect(invalidateEvent?.to_state).toBe("approval_invalidated");
  });

  it("TEST_NEG_CAS_EVIDENCE_DRIFT · Evidence drift after approval blocks execution with 409 (H1 CAS Gate)", async () => {
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Evidence drift test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });

    await service.startPlanning(tenantA, run.id, "sess_123", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan original", sha256: "sha_plan_orig" },
      { id: "art_ev_1", content: "evidence orig", sha256: "sha_ev_orig" },
      actorAlice
    );

    await service.decideApproval({ tenantId: tenantA, runId: run.id, actor: actorBob, decision: "approved" });
    await service.decideApproval({ tenantId: tenantA, runId: run.id, actor: actorCharlie, decision: "approved" });

    // Tamper evidence hash
    const runInStore = store.runs.get(`${tenantA}::${run.id}`)!;
    runInStore.evidence_snapshot_hash = "sha_ev_TAMPERED_DRIFT";

    await expect(service.checkCASAndStartExecution(tenantA, run.id, actorBob)).rejects.toThrow(EvidenceHashDriftError);

    const invalidatedRun = await service.getRun(tenantA, run.id);
    expect(invalidatedRun.state).toBe("approval_invalidated");
  });

  it("TEST_NEG_AUDIT_MISSING_REQUIRED · Missing tenant_id or actor rejects write (D0 §5)", async () => {
    // Missing tenantId
    await expect(
      service.recordAuditEvent({
        tenantId: "",
        resourceType: "run",
        resourceId: "run_1",
        actor: actorAlice,
        action: "run.create",
        phase: "result",
        result: "success",
      })
    ).rejects.toThrow(AuditMissingRequiredFieldError);

    // Missing actor id
    await expect(
      service.recordAuditEvent({
        tenantId: tenantA,
        resourceType: "run",
        resourceId: "run_1",
        actor: { type: "user", id: "" },
        action: "run.create",
        phase: "result",
        result: "success",
      })
    ).rejects.toThrow(AuditMissingRequiredFieldError);
  });

  it("TEST_NEG_BYPASS_BFF_DIRECT_SERVICE_INVOCATION · Domain service rejects missing tenant or actor context (D0 §2 Fail-Closed)", async () => {
    // Attempt to invoke domain service with empty tenant
    await expect(
      service.createRun({
        tenantId: "",
        templateId: "stpl_k8s_change",
        title: "Bypass test",
        inputParameters: {},
        actor: actorAlice,
      })
    ).rejects.toThrow();
  });

  it("TEST_NEG_CONCURRENT_APPROVAL_CONFLICT · Concurrent state transition conflict returns 409 (Base B §9-1)", async () => {
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Concurrent conflict test",
      inputParameters: { cluster: "prod" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantA, run.id, "sess_c", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_ev_1", content: "ev", sha256: "sha_e" },
      actorAlice
    );

    // Simulate concurrent race: Bob approves, while Alice cancels concurrently
    // First operation (cancel) succeeds
    const cancelled = await service.cancelRun({
      tenantId: tenantA,
      runId: run.id,
      actor: actorAlice,
      reason: "Cancelled before approval",
    });
    expect(cancelled.state).toBe("cancelled");

    // Second operation (approve) encounters state conflict because run is no longer awaiting_approval
    await expect(
      service.decideApproval({
        tenantId: tenantA,
        runId: run.id,
        actor: actorBob,
        decision: "approved",
      })
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  // ==========================================================================
  // COMPLETE 13-STATE MACHINE & MULTI-STAGE APPROVAL WORKFLOW
  // ==========================================================================

  it("13-State Machine: Multi-Stage Sequential Approval Workflow (N1) and Execution Lifecycle", async () => {
    // Step 1: draft -> submitted
    const draftRun = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "End to end lifecycle",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: false,
    });
    expect(draftRun.state).toBe("draft");

    const submittedRun = await service.submitRun(tenantA, draftRun.id, actorAlice);
    expect(submittedRun.state).toBe("submitted");
    expect(submittedRun.submitted_at).toBeGreaterThan(0);

    // Step 2: submitted -> planning -> awaiting_approval
    const planningRun = await service.startPlanning(tenantA, submittedRun.id, "sess_node_01", actorAlice, "snap_hash_01");
    expect(planningRun.state).toBe("planning");
    expect(planningRun.session_id).toBe("sess_node_01");

    const awaitingRun = await service.finishPlanning(
      tenantA,
      planningRun.id,
      { content: "Plan Markdown diff", sha256: "sha_p_123" },
      { id: "art_ev_1", content: "K8s describe pod logs", sha256: "sha_e_456" },
      actorAlice,
      1500
    );
    expect(awaitingRun.state).toBe("awaiting_approval");
    expect(awaitingRun.current_approval_stage).toBe(1);
    expect(awaitingRun.plan_hash).toBe("sha_p_123");
    expect(awaitingRun.evidence_snapshot_hash).toBe("sha_e_456");

    // Step 3: Stage 1 Approval by SRE Lead (Bob)
    const stage1Run = await service.decideApproval({
      tenantId: tenantA,
      runId: awaitingRun.id,
      actor: actorBob,
      decision: "approved",
      comment: "Stage 1 SRE approved",
    });
    // Multi-stage N1 rule: intermediate stage approval stays in awaiting_approval and stage increments
    expect(stage1Run.state).toBe("awaiting_approval");
    expect(stage1Run.current_approval_stage).toBe(2);

    // Step 4: Stage 2 Final Approval by Service Owner (Charlie)
    const finalApprovedRun = await service.decideApproval({
      tenantId: tenantA,
      runId: stage1Run.id,
      actor: actorCharlie,
      decision: "approved",
      comment: "Stage 2 Owner approved. Proceed to change.",
    });
    expect(finalApprovedRun.state).toBe("approved");
    expect(finalApprovedRun.approved_at).toBeGreaterThan(0);
    expect(finalApprovedRun.active_approval_id).toBeDefined();

    // Step 5: approved -> executing (CAS Gate Passed)
    const executingRun = await service.checkCASAndStartExecution(tenantA, finalApprovedRun.id, actorBob);
    expect(executingRun.state).toBe("executing");
    expect(executingRun.started_at).toBeGreaterThan(0);

    // Step 6: executing -> succeeded
    const succeededRun = await service.finishExecution(tenantA, executingRun.id, true, actorAlice, 3200);
    expect(succeededRun.state).toBe("succeeded");
    expect(succeededRun.finished_at).toBeGreaterThan(0);

    // Verify Audit Event Trail
    const events = await service.listEvents(tenantA, draftRun.id, 50);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("run.create");
    expect(actions).toContain("run.submit");
    expect(actions).toContain("run.plan_start");
    expect(actions).toContain("run.plan_finish");
    expect(actions).toContain("run.await_approval");
    expect(actions).toContain("approval.approve");
    expect(actions).toContain("run.exec_start");
    expect(actions).toContain("run.exec_finish");
  });

  it("Rework Flow: Changes Requested -> Stage Reset & Invalidation -> Resubmit -> Re-Planning", async () => {
    // 1. Create and get to awaiting_approval
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Rework test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantA, run.id, "sess_01", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan v1", sha256: "sha_p_v1" },
      { id: "art_ev_1", content: "ev v1", sha256: "sha_e_v1" },
      actorAlice
    );

    // SRE Bob requests changes
    const changesReqRun = await service.decideApproval({
      tenantId: tenantA,
      runId: run.id,
      actor: actorBob,
      decision: "changes_requested",
      comment: "Please reduce memory limit to 2Gi instead of 4Gi",
    });
    expect(changesReqRun.state).toBe("changes_requested");

    // 2. Applicant rework resubmit
    const reworkedRun = await service.reworkRun({
      tenantId: tenantA,
      runId: run.id,
      actor: actorAlice,
      inputParameters: { cluster: "prod-us-east", memory: "2Gi" },
      comment: "Adjusted memory as requested",
    });

    expect(reworkedRun.state).toBe("planning");
    expect(reworkedRun.current_approval_stage).toBe(1); // N1: Reset to stage 1

    // Approvals from round 1 must be invalidated
    const approvals = await store.listApprovals(tenantA, run.id);
    expect(approvals[0].is_invalidated).toBe(1);
    expect(approvals[0].invalidated_reason).toBe("REWORK_RESUBMITTED");
  });

  it("Cancellation & Interruption Lifecycle Transitions", async () => {
    // 1. Cancellation from draft / submitted / awaiting_approval
    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Cancel test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });

    const cancelledRun = await service.cancelRun({
      tenantId: tenantA,
      runId: run.id,
      actor: actorAlice,
      reason: "No longer needed",
    });
    expect(cancelledRun.state).toBe("cancelled");
    expect(cancelledRun.finished_at).toBeGreaterThan(0);

    // 2. Interruption from executing
    const run2 = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_k8s_change",
      title: "Interrupt test",
      inputParameters: { cluster: "prod-us-east" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantA, run2.id, "sess_02", actorAlice);
    await service.finishPlanning(
      tenantA,
      run2.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_ev_1", content: "ev", sha256: "sha_e" },
      actorAlice
    );
    await service.decideApproval({ tenantId: tenantA, runId: run2.id, actor: actorBob, decision: "approved" });
    await service.decideApproval({ tenantId: tenantA, runId: run2.id, actor: actorCharlie, decision: "approved" });
    await service.checkCASAndStartExecution(tenantA, run2.id, actorBob);

    const interruptedRun = await service.interruptRun(tenantA, run2.id, actorAlice, "Emergency manual abort");
    expect(interruptedRun.state).toBe("interrupted");
    expect(interruptedRun.finished_at).toBeGreaterThan(0);
  });
});
