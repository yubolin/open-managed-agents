// Base B · Operations Workspace BFF API 13 Endpoints Test Suite.

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  InMemoryOperationsStore,
  OperationsService,
} from "@open-managed-agents/operations-store";
import { operationsRoutes, verifyTicket } from "@open-managed-agents/http-routes";
import type { Env } from "@open-managed-agents/shared";

describe("Base B · Operations Workspace BFF 13 Endpoints", () => {
  let store: InMemoryOperationsStore;
  let service: OperationsService;
  let app: Hono;

  const tenantId = "tenant_test_123";
  const userId = "user_operator_bob";

  beforeEach(async () => {
    store = new InMemoryOperationsStore();
    service = new OperationsService(store);

    // Seed a test template
    await store.insertTemplate(
      {
        id: "stpl_diag_k8s",
        tenant_id: tenantId,
        name: "K8s Readonly Diagnosis",
        code: "diag_k8s",
        category: "diagnostic",
        description: "Readonly pod diagnosis",
        is_active: 1,
        current_version_id: "stplv_1",
        created_by: "system",
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: "stplv_1",
        template_id: "stpl_diag_k8s",
        tenant_id: tenantId,
        version: 1,
        is_active: 1,
        agent_binding: JSON.stringify({ agent_id: "agent_k8s_diag", version: 1 }),
        form_schema: JSON.stringify({
          type: "object",
          properties: { namespace: { type: "string" } },
          required: ["namespace"],
        }),
        ui_schema: JSON.stringify({ "ui:order": ["namespace"] }),
        approval_policy: JSON.stringify({
          mode: "sequential_groups",
          stages: [{ stage_order: 1, stage_name: "SRE Lead", group_id: "grp_sre", required_approvals: 1 }],
        }),
        timeout_policy: JSON.stringify({ approval_timeout_minutes: 30, escalation_interval_minutes: 10, escalation_actions: [] }),
        changelog: "v1.0",
        published_by: "system",
        published_at: 1000,
      }
    );

    // Build Hono app
    const root = new Hono();
    // Simulate auth middleware
    root.use("*", async (c, next) => {
      c.set("tenant_id" as any, tenantId);
      c.set("user_id" as any, userId);
      c.set("user_name" as any, "Bob");
      await next();
    });

    const routes = operationsRoutes(() => service);
    root.route("/v1/workspace", routes);
    app = root;
  });

  // #1 GET /v1/workspace/templates
  it("#1 GET /v1/workspace/templates returns list of active templates", async () => {
    const res = await app.request("http://localhost/v1/workspace/templates");
    expect(res.status).toBe(200);
    const body = await res.json<{ templates: Array<{ id: string; name: string }> }>();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].id).toBe("stpl_diag_k8s");
  });

  // #2 GET /v1/workspace/templates/:id/version
  it("#2 GET /v1/workspace/templates/:id/version returns parsed schemas", async () => {
    const res = await app.request("http://localhost/v1/workspace/templates/stpl_diag_k8s/version");
    expect(res.status).toBe(200);
    const body = await res.json<{ template: { code: string }; version: { form_schema: { required: string[] } } }>();
    expect(body.template.code).toBe("diag_k8s");
    expect(body.version.form_schema.required).toContain("namespace");
  });

  // #3 POST /v1/workspace/runs (Create run)
  it("#3 POST /v1/workspace/runs creates a run and returns 201", async () => {
    const res = await app.request("http://localhost/v1/workspace/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template_id: "stpl_diag_k8s",
        title: "Diagnose checkout pod crash",
        input_parameters: { namespace: "checkout-prod" },
        auto_submit: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ run: { id: string; state: string } }>();
    expect(body.run.id).toMatch(/^run_/);
    expect(body.run.state).toBe("draft");
  });

  // #4 POST /v1/workspace/runs/:id/submit
  it("#4 POST /v1/workspace/runs/:id/submit submits draft run", async () => {
    const createRes = await app.request("http://localhost/v1/workspace/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template_id: "stpl_diag_k8s",
        title: "Submit test",
        input_parameters: { namespace: "prod" },
        auto_submit: false,
      }),
    });
    const { run } = await createRes.json<{ run: { id: string } }>();

    const submitRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}/submit`, {
      method: "POST",
    });
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json<{ run: { state: string } }>();
    expect(submitBody.run.state).toBe("submitted");
  });

  // #5 POST /v1/workspace/runs/:id/rework
  it("#5 POST /v1/workspace/runs/:id/rework allows resubmission on changes_requested", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Rework API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: "user_applicant" },
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_01", { type: "user", id: "user_applicant" });
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_1", content: "ev", sha256: "sha_e" },
      { type: "user", id: "user_applicant" }
    );
    // Reject with request_changes
    await service.decideApproval({
      tenantId,
      runId: run.id,
      actor: { type: "user", id: userId },
      decision: "changes_requested",
      comment: "Fix namespace",
    });

    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}/rework`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input_parameters: { namespace: "prod-fixed" },
        comment: "Fixed namespace",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ run: { state: string; current_approval_stage: number } }>();
    expect(body.run.state).toBe("planning");
    expect(body.run.current_approval_stage).toBe(1);
  });

  // #6 POST /v1/workspace/runs/:id/cancel
  it("#6 POST /v1/workspace/runs/:id/cancel cancels a run", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Cancel API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: userId },
      autoSubmit: true,
    });

    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "User cancelled" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ run: { state: string } }>();
    expect(body.run.state).toBe("cancelled");
  });

  // #7 GET /v1/workspace/runs (List)
  it("#7 GET /v1/workspace/runs lists runs with filter", async () => {
    const res = await app.request("http://localhost/v1/workspace/runs?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json<{ runs: unknown[] }>();
    expect(Array.isArray(body.runs)).toBe(true);
  });

  // #8 GET /v1/workspace/runs/:id (Detail)
  it("#8 GET /v1/workspace/runs/:id returns run details, approvals and artifacts", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Detail API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: userId },
      autoSubmit: true,
    });

    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ run: { id: string }; approvals: unknown[]; artifacts: unknown[] }>();
    expect(body.run.id).toBe(run.id);
    expect(Array.isArray(body.approvals)).toBe(true);
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  // #9 GET /v1/workspace/runs/:id/artifacts
  it("#9 GET /v1/workspace/runs/:id/artifacts returns artifact list", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Artifacts API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: "user_app" },
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_1", { type: "user", id: "user_app" });
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan content", sha256: "sha_p_01" },
      { id: "art_ev_1", content: "ev content", sha256: "sha_e_01" },
      { type: "user", id: "user_app" }
    );

    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json<{ artifacts: Array<{ type: string; content_sha256: string }> }>();
    expect(body.artifacts).toHaveLength(2);
  });

  // #10 GET /v1/workspace/approvals (Pending approvals)
  it("#10 GET /v1/workspace/approvals returns pending runs for approval center", async () => {
    const res = await app.request("http://localhost/v1/workspace/approvals");
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_runs: unknown[] }>();
    expect(Array.isArray(body.pending_runs)).toBe(true);
  });

  // #11 POST /v1/workspace/runs/:id/approve
  it("#11 POST /v1/workspace/runs/:id/approve approves a run", async () => {
    // Applicant creates run (must not be Bob to satisfy SoD)
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Approve API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: "user_alice_applicant" },
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_1", { type: "user", id: "user_alice_applicant" });
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_1", content: "ev", sha256: "sha_e" },
      { type: "user", id: "user_alice_applicant" }
    );

    // Bob approves
    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "Approved by SRE Lead" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ run: { state: string } }>();
    expect(body.run.state).toBe("approved");
  });

  // #12 POST /v1/workspace/runs/:id/reject
  it("#12 POST /v1/workspace/runs/:id/reject rejects a run", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_diag_k8s",
      title: "Reject API test",
      inputParameters: { namespace: "prod" },
      actor: { type: "user", id: "user_alice_applicant" },
      autoSubmit: true,
    });
    await service.startPlanning(tenantId, run.id, "sess_1", { type: "user", id: "user_alice_applicant" });
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_1", content: "ev", sha256: "sha_e" },
      { type: "user", id: "user_alice_applicant" }
    );

    const res = await app.request(`http://localhost/v1/workspace/runs/${run.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reject", comment: "Denied due to high risk" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ run: { state: string } }>();
    expect(body.run.state).toBe("rejected");
  });

  // #13 POST /v1/workspace/auth/ticket
  it("#13 POST /v1/workspace/auth/ticket issues one-time short-lived ticket for SSE", async () => {
    const res = await app.request("http://localhost/v1/workspace/auth/ticket", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ticket: string; expires_in_seconds: number }>();
    expect(body.ticket).toBeDefined();
    expect(body.expires_in_seconds).toBe(30);

    // Verify ticket validity and single-use
    const verified = verifyTicket(body.ticket);
    expect(verified).not.toBeNull();
    expect(verified?.tenantId).toBe(tenantId);
    expect(verified?.userId).toBe(userId);

    // Second use must fail
    expect(verifyTicket(body.ticket)).toBeNull();
  });
});
