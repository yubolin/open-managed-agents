import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  OperationsError,
  type AuditActor,
  type OperationsService,
} from "@open-managed-agents/operations-store";

export interface OperationsVariables {
  tenant_id: string;
  user_id?: string;
  user_name?: string;
  operationsService?: OperationsService;
}

// Ticket store for SSE auth (30s TTL)
const sseTicketStore = new Map<string, { tenantId: string; userId: string; expiresAt: number }>();

function generateTicket(tenantId: string, userId: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ticket = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  sseTicketStore.set(ticket, {
    tenantId,
    userId,
    expiresAt: Date.now() + 30_000,
  });
  return ticket;
}

export function verifyTicket(ticket: string): { tenantId: string; userId: string } | null {
  const entry = sseTicketStore.get(ticket);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sseTicketStore.delete(ticket);
    return null;
  }
  sseTicketStore.delete(ticket); // single use
  return { tenantId: entry.tenantId, userId: entry.userId };
}

export function operationsRoutes(getOperationsService: (c: { env: Env; var: Record<string, unknown> }) => OperationsService) {
  const app = new Hono<{
    Bindings: Env;
    Variables: OperationsVariables;
  }>();

  // Middleware to ensure operationsService & tenant context
  app.use("*", async (c, next) => {
    const tenantId = c.var.tenant_id;
    if (!tenantId) {
      return c.json({ error: "Unauthorized: Missing tenant context", code: "UNAUTHORIZED" }, 401);
    }
    c.set("operationsService", getOperationsService(c));
    await next();
  });

  const getActor = (c: { var: OperationsVariables }): AuditActor => {
    const userId = c.var.user_id || "user_anonymous";
    return {
      type: "user",
      id: userId,
      name: c.var.user_name || undefined,
    };
  };

  // Helper for error handling
  const handleError = (c: { json: (data: unknown, status: number) => Response }, err: unknown) => {
    if (err instanceof OperationsError) {
      return c.json({ error: err.message, code: err.errorCode }, err.statusCode as 400 | 403 | 404 | 409);
    }
    const message = err instanceof Error ? err.message : "Internal Server Error";
    return c.json({ error: message, code: "INTERNAL_ERROR" }, 500);
  };

  // --------------------------------------------------------------------------
  // 1. Service Templates (#1, #2)
  // --------------------------------------------------------------------------

  // #1 GET /v1/workspace/templates
  app.get("/templates", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const category = c.req.query("category");
      const service = c.var.operationsService!;
      const templates = await service.listTemplates(tenantId, category);
      return c.json({ templates });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #2 GET /v1/workspace/templates/:id/version
  app.get("/templates/:id/version", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const templateId = c.req.param("id");
      const versionId = c.req.query("version_id");
      const service = c.var.operationsService!;

      const template = await service.getTemplate(tenantId, templateId);
      const targetVersionId = versionId || template.current_version_id;
      if (!targetVersionId) {
        return c.json({ error: "No published version found for template", code: "VERSION_NOT_FOUND" }, 404);
      }

      const version = await service.getTemplateVersion(tenantId, targetVersionId);
      return c.json({
        template,
        version: {
          ...version,
          agent_binding: JSON.parse(version.agent_binding),
          form_schema: JSON.parse(version.form_schema),
          ui_schema: version.ui_schema ? JSON.parse(version.ui_schema) : null,
          approval_policy: JSON.parse(version.approval_policy),
          timeout_policy: JSON.parse(version.timeout_policy),
        },
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // --------------------------------------------------------------------------
  // 2. Runs Lifecycle (#3, #4, #5, #6, #7, #8, #9)
  // --------------------------------------------------------------------------

  // #3 POST /v1/workspace/runs
  app.post("/runs", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const body = await c.req.json<{
        template_id: string;
        template_version_id?: string;
        title: string;
        input_parameters: Record<string, unknown>;
        knowledge_refs?: Record<string, unknown>;
        auto_submit?: boolean;
      }>();

      if (!body.template_id || !body.title || !body.input_parameters) {
        return c.json({ error: "Missing required fields (template_id, title, input_parameters)", code: "BAD_REQUEST" }, 400);
      }

      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.createRun({
        tenantId,
        templateId: body.template_id,
        templateVersionId: body.template_version_id,
        title: body.title,
        inputParameters: body.input_parameters,
        knowledgeRefs: body.knowledge_refs,
        autoSubmit: body.auto_submit ?? false,
        actor,
      });

      return c.json({ run }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #4 POST /v1/workspace/runs/:id/submit
  app.post("/runs/:id/submit", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.submitRun(tenantId, runId, actor);
      return c.json({ run });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #5 POST /v1/workspace/runs/:id/rework
  app.post("/runs/:id/rework", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const body = await c.req.json<{
        input_parameters?: Record<string, unknown>;
        comment?: string;
      }>().catch(() => ({ input_parameters: undefined, comment: undefined }));

      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.reworkRun({
        tenantId,
        runId,
        actor,
        inputParameters: body.input_parameters,
        comment: body.comment,
      });

      return c.json({ run });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #6 POST /v1/workspace/runs/:id/cancel
  app.post("/runs/:id/cancel", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));

      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.cancelRun({
        tenantId,
        runId,
        actor,
        reason: body.reason,
      });

      return c.json({ run });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #7 GET /v1/workspace/runs
  app.get("/runs", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const state = c.req.query("state");
      const createdBy = c.req.query("created_by");
      const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50;
      const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

      const service = c.var.operationsService!;
      const runs = await service.listRuns(tenantId, {
        state: state as any,
        createdBy,
        limit,
        offset,
      });

      return c.json({ runs });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #8 GET /v1/workspace/runs/:id
  app.get("/runs/:id", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const service = c.var.operationsService!;

      const run = await service.getRun(tenantId, runId);
      const approvals = await service.listApprovals(tenantId, runId);
      const artifacts = await service.listArtifacts(tenantId, runId);

      return c.json({
        run,
        approvals,
        artifacts,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #9 GET /v1/workspace/runs/:id/artifacts
  app.get("/runs/:id/artifacts", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const type = c.req.query("type");
      const service = c.var.operationsService!;

      // Ensure run exists & belongs to tenant
      await service.getRun(tenantId, runId);
      const artifacts = await service.listArtifacts(tenantId, runId, type);
      return c.json({ artifacts });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // --------------------------------------------------------------------------
  // 3. Approval Center & Decisions (#10, #11, #12)
  // --------------------------------------------------------------------------

  // #10 GET /v1/workspace/approvals
  app.get("/approvals", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const service = c.var.operationsService!;

      // List all runs in awaiting_approval state
      const awaitingRuns = await service.listRuns(tenantId, { state: "awaiting_approval" });
      return c.json({ pending_runs: awaitingRuns });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #11 POST /v1/workspace/runs/:id/approve
  app.post("/runs/:id/approve", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const body = await c.req.json<{ comment?: string }>().catch(() => ({ comment: undefined }));

      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.decideApproval({
        tenantId,
        runId,
        actor,
        decision: "approved",
        comment: body.comment,
      });

      return c.json({ run });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // #12 POST /v1/workspace/runs/:id/reject
  app.post("/runs/:id/reject", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const runId = c.req.param("id");
      const body = await c.req.json<{
        action?: "reject" | "request_changes";
        comment?: string;
      }>();

      const decision = body.action === "request_changes" ? "changes_requested" : "rejected";
      const service = c.var.operationsService!;
      const actor = getActor(c);

      const run = await service.decideApproval({
        tenantId,
        runId,
        actor,
        decision,
        comment: body.comment,
      });

      return c.json({ run });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // --------------------------------------------------------------------------
  // 4. SSE Ticket (#13)
  // --------------------------------------------------------------------------

  // #13 POST /v1/workspace/auth/ticket
  app.post("/auth/ticket", async (c) => {
    try {
      const tenantId = c.var.tenant_id;
      const userId = c.var.user_id || "user_anonymous";
      const ticket = generateTicket(tenantId, userId);
      return c.json({
        ticket,
        expires_in_seconds: 30,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}
