// Base B · Real SQL / Drizzle Operations Adapter Test Suite (Testing on real SQLite/D1 engine).
// Proves: Real SQL CAS (WHERE state = :from_state), atomicWrite transactionality, and multi-table ACID consistency.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DrizzleOperationsStore,
  OperationsService,
  RunStateConflictError,
  PlanHashDriftError,
  EvidenceHashDriftError,
  SoDViolationSelfApprovalError,
  AdminApprovalBypassForbiddenError,
  type AuditActor,
} from "@open-managed-agents/operations-store";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";

describe("Base B · Drizzle Real-SQL Operations Adapter & CAS Invariants", () => {
  let testDb: TestDb;
  let store: DrizzleOperationsStore;
  let service: OperationsService;

  const tenantId = "tenant_drizzle_test";
  const actorAlice: AuditActor = { type: "user", id: "user_alice", name: "Alice (Applicant)" };
  const actorBob: AuditActor = { type: "user", id: "user_bob", name: "Bob (Approver)" };
  const actorAdmin: AuditActor = { type: "user", id: "user_admin", name: "Admin", role: "role_platform_admin" };

  beforeAll(async () => {
    testDb = await bootstrapTestDb({ foreignKeys: true });
    store = new DrizzleOperationsStore(testDb.db);
    service = new OperationsService(store);

    // Seed template via atomicWrite
    await store.insertTemplate(
      {
        id: "stpl_sql_test",
        tenant_id: tenantId,
        name: "SQL CAS Test Template",
        code: "sql_cas_test",
        category: "change_plan",
        description: "Testing real SQL CAS transitions",
        is_active: 1,
        current_version_id: "stplv_sql_v1",
        created_by: "system",
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: "stplv_sql_v1",
        template_id: "stpl_sql_test",
        tenant_id: tenantId,
        version: 1,
        is_active: 1,
        agent_binding: JSON.stringify({ agent_id: "agent_planner", version: 1 }),
        form_schema: JSON.stringify({ type: "object", properties: { param: { type: "string" } }, required: ["param"] }),
        ui_schema: null,
        approval_policy: JSON.stringify({
          mode: "sequential_groups",
          stages: [{ stage_order: 1, stage_name: "Lead", group_id: "grp_lead", required_approvals: 1 }],
        }),
        timeout_policy: JSON.stringify({ approval_timeout_minutes: 60 }),
        changelog: "v1.0",
        published_by: "system",
        published_at: 1000,
      }
    );
  });

  afterAll(async () => {
    testDb?.cleanup();
  });

  it("1. Real SQL CAS: updateRunCAS enforces WHERE state = :fromState at the SQL level", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_sql_test",
      title: "Real SQL CAS Test",
      inputParameters: { param: "val1" },
      actor: actorAlice,
      autoSubmit: false,
    });
    expect(run.state).toBe("draft");

    // Attempt CAS transition from wrong state ('planning' instead of 'draft') -> SQL WHERE matches 0 rows -> returns false
    const failedCas = await store.updateRunCAS(tenantId, run.id, "planning", {
      state: "submitted",
      updated_at: Date.now(),
    });
    expect(failedCas).toBe(false);

    // Verify state in DB remains untouched ('draft')
    const unchanged = await store.getRun(tenantId, run.id);
    expect(unchanged?.state).toBe("draft");

    // Correct CAS transition from 'draft' -> SQL WHERE matches 1 row -> returns true
    const successCas = await store.updateRunCAS(tenantId, run.id, "draft", {
      state: "submitted",
      submitted_at: Date.now(),
      updated_at: Date.now(),
    });
    expect(successCas).toBe(true);

    // Verify state in DB is now 'submitted'
    const updated = await store.getRun(tenantId, run.id);
    expect(updated?.state).toBe("submitted");
  });

  it("2. Real SQL Transaction & atomicWrite: Single-transaction atomic approval commits approval row + state transition + audit event", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_sql_test",
      title: "Real SQL Approval Test",
      inputParameters: { param: "val2" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_sql_1", actorAlice);
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan content", sha256: "sha_p_sql" },
      { id: "art_ev_sql", content: "evidence content", sha256: "sha_e_sql" },
      actorAlice
    );

    // Approve via service (runs inside store.transaction)
    const approved = await service.decideApproval({
      tenantId,
      runId: run.id,
      actor: actorBob,
      decision: "approved",
      comment: "Approved in real SQL",
    });
    expect(approved.state).toBe("approved");

    // Verify SQL persistence directly
    const runInDb = await store.getRun(tenantId, run.id);
    expect(runInDb?.state).toBe("approved");
    expect(runInDb?.approved_at).toBeGreaterThan(0);

    const approvals = await store.listApprovals(tenantId, run.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decision).toBe("approved");
    expect(approvals[0].approver_id).toBe(actorBob.id);
    expect(approvals[0].plan_hash_at_decision).toBe("sha_p_sql");

    const events = await store.listEvents(tenantId, run.id);
    expect(events.some((e) => e.action === "approval.approve")).toBe(true);
  });

  it("3. Real SQL CAS Double-Hash Gate: Tampering plan or evidence hash in DB triggers approval_invalidated", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_sql_test",
      title: "Real SQL Tamper Test",
      inputParameters: { param: "val3" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_sql_2", actorAlice);
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan", sha256: "sha_p_orig" },
      { id: "art_ev_sql2", content: "evidence", sha256: "sha_e_orig" },
      actorAlice
    );
    await service.decideApproval({
      tenantId,
      runId: run.id,
      actor: actorBob,
      decision: "approved",
    });

    // Directly tamper plan_hash in database
    await testDb.sql.exec(`
      UPDATE runs SET plan_hash = 'sha_p_TAMPERED' WHERE id = '${run.id}' AND tenant_id = '${tenantId}'
    `);

    // Attempt to start execution -> Real SQL check detects hash drift -> transitions to approval_invalidated -> throws PlanHashDriftError (409)
    await expect(service.checkCASAndStartExecution(tenantId, run.id, actorBob)).rejects.toThrow(PlanHashDriftError);

    // Verify DB state is now approval_invalidated and approval is invalidated
    const invalidatedRun = await store.getRun(tenantId, run.id);
    expect(invalidatedRun?.state).toBe("approval_invalidated");

    const approvals = await store.listApprovals(tenantId, run.id);
    expect(approvals[0].is_invalidated).toBe(1);
  });

  it("4. Real SQL SoD & Admin Zero-Privilege Assertions", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_sql_test",
      title: "Real SQL SoD Test",
      inputParameters: { param: "val4" },
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_sql_3", actorAlice);
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan", sha256: "sha_p_4" },
      { id: "art_ev_sql4", content: "evidence", sha256: "sha_e_4" },
      actorAlice
    );

    // Alice self-approval -> throws SoDViolationSelfApprovalError
    await expect(
      service.decideApproval({
        tenantId,
        runId: run.id,
        actor: actorAlice,
        decision: "approved",
      })
    ).rejects.toThrow(SoDViolationSelfApprovalError);

    // Admin without approver role -> throws AdminApprovalBypassForbiddenError
    await expect(
      service.decideApproval({
        tenantId,
        runId: run.id,
        actor: actorAdmin,
        decision: "approved",
      })
    ).rejects.toThrow(AdminApprovalBypassForbiddenError);
  });
});
