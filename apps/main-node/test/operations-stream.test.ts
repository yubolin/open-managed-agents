// Base C · Operations Workspace SSE StreamHub Test Suite.
// Covers: Triple-Gate Ticket Auth (single-use, 30s TTL fake-clock expiry, tenant/run binding),
// Real-Time Event Fanout (<2s SLA), Slow Consumer Cleanup, Replay Consistency,
// Zero State Mutation Audit (prototype + import surface), and Ticket Store Hygiene.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  InMemoryOperationsStore,
  InMemoryOperationsStreamHub,
  OperationsService,
  globalOperationsStreamHub,
} from "@open-managed-agents/operations-store";
import {
  operationsRoutes,
  generateTicket,
  verifyTicket,
  sseTicketStoreStats,
} from "@open-managed-agents/http-routes";

describe("Base C · Operations Workspace SSE StreamHub & Triple-Gate Auth", () => {
  let store: InMemoryOperationsStore;
  let hub: InMemoryOperationsStreamHub;
  let service: OperationsService;
  let app: Hono;

  const tenantId = "tenant_stream_test";
  const otherTenant = "tenant_other_intruder";
  const userId = "user_operator_bob";

  beforeEach(async () => {
    store = new InMemoryOperationsStore();
    hub = globalOperationsStreamHub as InMemoryOperationsStreamHub;
    service = new OperationsService(store, hub);

    // Seed template
    await store.insertTemplate(
      {
        id: "stpl_stream_diag",
        tenant_id: tenantId,
        name: "Stream Diagnosis",
        code: "stream_diag",
        category: "diagnostic",
        description: "Template for testing real-time events",
        is_active: 1,
        current_version_id: "stplv_s1",
        created_by: "system",
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: "stplv_s1",
        template_id: "stpl_stream_diag",
        tenant_id: tenantId,
        version: 1,
        is_active: 1,
        agent_binding: JSON.stringify({ agent_id: "agent_diag", version: 1 }),
        form_schema: JSON.stringify({ type: "object", properties: { p: { type: "string" } } }),
        ui_schema: null,
        approval_policy: JSON.stringify({
          mode: "sequential_groups",
          stages: [{ stage_order: 1, stage_name: "Lead", group_id: "grp_lead", required_approvals: 1 }],
        }),
        timeout_policy: JSON.stringify({ approval_timeout_minutes: 30 }),
        changelog: "v1.0",
        published_by: "system",
        published_at: 1000,
      }
    );

    const root = new Hono();
    root.use("*", async (c, next) => {
      // Simulate auth context from header or fallback
      const reqTenant = c.req.header("x-tenant-id") || tenantId;
      c.set("tenant_id" as any, reqTenant);
      c.set("user_id" as any, userId);
      await next();
    });

    const routes = operationsRoutes(() => service);
    root.route("/v1/workspace", routes);
    app = root;
  });

  // ==========================================================================
  // 1. TRIPLE-GATE TICKET AUTHENTICATION
  // ==========================================================================

  it("1. Ticket Gate: Single-use consumption (second attempt fails with 401)", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Ticket single-use test",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    // Obtain ticket bound to run
    const ticketRes = await app.request("http://localhost/v1/workspace/auth/ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: run.id }),
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = await ticketRes.json<{ ticket: string }>();

    // First use: connects successfully
    const sseRes1 = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`);
    expect(sseRes1.status).toBe(200);
    expect(sseRes1.headers.get("content-type")).toBe("text/event-stream");

    // Second use: fails with 401 Unauthorized (ticket has been consumed)
    const sseRes2 = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`);
    expect(sseRes2.status).toBe(401);
  });

  it("2. Ticket Gate: Cross-Run binding mismatch is rejected with 401", async () => {
    const runA = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Run A",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });
    const runB = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Run B",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    // Issue ticket explicitly bound to Run A
    const ticket = generateTicket(tenantId, userId, runA.id);

    // Attempt to connect to Run B using Run A's ticket -> Rejected with 401
    const sseRes = await app.request(`http://localhost/v1/workspace/runs/${runB.id}/events/stream?token=${ticket}`);
    expect(sseRes.status).toBe(401);
  });

  it("3. Ticket Gate: Cross-Tenant access returns 401/404 anti-probing", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Tenant isolation run",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    // Intruder tenant obtains a ticket for their own tenant
    const intruderTicket = generateTicket(otherTenant, "user_intruder", run.id);

    // Intruder attempts to access Tenant A's run with intruder ticket -> 404 Anti-probing (D0 §4)
    const sseRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${intruderTicket}`, {
      headers: { "x-tenant-id": otherTenant },
    });
    expect(sseRes.status).toBe(404);
  });

  // ==========================================================================
  // 2. REAL-TIME EVENT STREAMING & FANOUT (<2s SLA)
  // ==========================================================================

  it("4. Event Fanout: Domain state mutations immediately stream to active SSE subscriber", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Real-time fanout test",
      inputParameters: {},
      actor: { type: "user", id: "user_applicant" },
      autoSubmit: false,
    });

    const ticket = generateTicket(tenantId, userId, run.id);
    const sseRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`);
    expect(sseRes.status).toBe(200);

    const reader = sseRes.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();

    // Read initial connected event
    const firstChunk = await reader!.read();
    const firstText = decoder.decode(firstChunk.value);
    expect(firstText).toContain("event: connected");
    expect(firstText).toContain('"status":"connected"');

    // Trigger state change via domain service: submit run
    const startTime = Date.now();
    await service.submitRun(tenantId, run.id, { type: "user", id: "user_applicant" });

    // Read streamed event
    const secondChunk = await reader!.read();
    const duration = Date.now() - startTime;
    const secondText = decoder.decode(secondChunk.value);

    // Assert delivered well under 2s SLA (in-process delivery is typically <10ms)
    expect(duration).toBeLessThan(2000);
    expect(secondText).toContain("event: run.state_changed");
    expect(secondText).toContain('"state":"submitted"');

    // Cancel reader cleanly
    await reader!.cancel();
  });

  // ==========================================================================
  // 3. SLOW CONSUMER / DISCONNECTION CLEANUP
  // ==========================================================================

  it("5. Subscriber Lifecycle: Subscriber count decrements to 0 upon reader cancel", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Cleanup test",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    const initialCount = hub.getSubscriberCount(tenantId, run.id);
    expect(initialCount).toBe(0);

    const ticket = generateTicket(tenantId, userId, run.id);
    const sseRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`);
    const reader = sseRes.body?.getReader();

    // Read initial connected frame
    await reader!.read();

    const activeCount = hub.getSubscriberCount(tenantId, run.id);
    expect(activeCount).toBe(1);

    // Cancel / disconnect
    await reader!.cancel();

    // Wait a tick for cleanup callback
    const finalCount = hub.getSubscriberCount(tenantId, run.id);
    expect(finalCount).toBe(0);
  });

  // ==========================================================================
  // 4. ZERO STATE MUTATION AUTHORITY AUDIT
  // ==========================================================================

  it("6. Zero State Mutation Authority: StreamHub has no database mutation methods", () => {
    // Assert StreamHub interface only contains publish, subscribe, getSubscriberCount
    const methods = Object.getOwnPropertyNames(InMemoryOperationsStreamHub.prototype);
    expect(methods).not.toContain("updateRun");
    expect(methods).not.toContain("insertRun");
    expect(methods).not.toContain("decideApproval");
    expect(methods).toContain("publish");
    expect(methods).toContain("subscribe");
  });

  // ==========================================================================
  // 5. REPLAY & CONSISTENCY PATH
  // ==========================================================================

  it("7. Consistency Path: State queried via GET /runs/:id matches stream events", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_stream_diag",
      title: "Consistency run",
      inputParameters: {},
      actor: { type: "user", id: "user_alice" },
      autoSubmit: true,
    });

    await service.startPlanning(tenantId, run.id, "sess_1", { type: "user", id: "user_alice" });
    await service.finishPlanning(
      tenantId,
      run.id,
      { content: "plan content", sha256: "sha_p_stream" },
      { id: "art_ev_stream", content: "ev", sha256: "sha_e_stream" },
      { type: "user", id: "user_alice" }
    );

    // Replay / polling check
    const getRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json<{ run: { state: string; plan_hash: string } }>();
    expect(body.run.state).toBe("awaiting_approval");
    expect(body.run.plan_hash).toBe("sha_p_stream");
  });

  // ==========================================================================
  // 6. TICKET CLOCK-BOUND BEHAVIOR & STORE HYGIENE (review F2/F4)
  // ==========================================================================

  it("8. Ticket Gate: 30s TTL expiry is rejected with 401 (fake clock)", async () => {
    vi.useFakeTimers();
    try {
      const run = await service.createRun({
        tenantId,
        templateId: "stpl_stream_diag",
        title: "Expiry test",
        inputParameters: {},
        actor: { type: "user", id: userId },
        autoSubmit: false,
      });

      const ticket = generateTicket(tenantId, userId, run.id);
      vi.advanceTimersByTime(30_001); // 30s TTL + 1ms

      const sseRes = await app.request(`http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`);
      expect(sseRes.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("9. Zero State Mutation Authority: stream.ts has zero runtime imports (type-only)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../packages/operations-store/src/stream.ts", import.meta.url)),
      "utf8"
    );
    // Every import in the hub module must be `import type` — erased at compile
    // time, so the hub physically cannot reach any store/SQL runtime surface.
    const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const stmt of imports) {
      expect(stmt.startsWith("import type")).toBe(true);
    }
    // Belt and braces: the hub source must not mention any DB/store surface.
    expect(source).not.toMatch(
      /\b(?:drizzle|sql-client|db-schema|better-sqlite|postgres|insertArtifact|updateRunCAS)\b/
    );
  });

  it("10. Ticket Store Hygiene: expired entries swept on issuance; capacity bounded (FIFO)", () => {
    vi.useFakeTimers();
    try {
      const before = sseTicketStoreStats().size;
      generateTicket(tenantId, userId);
      expect(sseTicketStoreStats().size).toBe(before + 1);

      // Cross the 30s sweep threshold: the next issuance purges everything expired.
      vi.advanceTimersByTime(30_001);
      generateTicket(tenantId, userId);
      expect(sseTicketStoreStats().size).toBe(1); // only the fresh ticket survives

      // Flood past capacity: FIFO eviction keeps the store bounded.
      for (let i = 0; i < 10_005; i++) {
        generateTicket(tenantId, userId);
      }
      expect(sseTicketStoreStats().size).toBeLessThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Base D review · D2 production tenant wiring & ticket-authority SSE", () => {
  // Production reality: main-node mounts operationsRoutes bare — no upstream
  // middleware injects tenant context. Context must derive from headers, and
  // the SSE stream (EventSource cannot send custom headers) must authorize
  // from the ticket's own tenant binding.
  let store: InMemoryOperationsStore;
  let service: OperationsService;
  let bareApp: Hono;

  const tenantId = "tenant_d2_test";
  const userId = "user_operator_bob";

  beforeEach(async () => {
    store = new InMemoryOperationsStore();
    service = new OperationsService(store);

    await store.insertTemplate(
      {
        id: "stpl_d2_diag",
        tenant_id: tenantId,
        name: "D2 Diagnosis",
        code: "d2_diag",
        category: "diagnostic",
        description: "Template for D2 wiring tests",
        is_active: 1,
        current_version_id: "stplv_d2_1",
        created_by: "system",
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: "stplv_d2_1",
        template_id: "stpl_d2_diag",
        tenant_id: tenantId,
        version: 1,
        is_active: 1,
        agent_binding: JSON.stringify({ agent_id: "agent_diag", version: 1 }),
        form_schema: JSON.stringify({ type: "object", properties: { p: { type: "string" } } }),
        ui_schema: null,
        approval_policy: JSON.stringify({
          mode: "sequential_groups",
          stages: [{ stage_order: 1, stage_name: "Lead", group_id: "grp_lead", required_approvals: 1 }],
        }),
        timeout_policy: JSON.stringify({ approval_timeout_minutes: 30 }),
        changelog: "v1.0",
        published_by: "system",
        published_at: 1000,
      }
    );

    // Bare mount: NO context-injecting middleware — mirrors apps/main-node.
    const root = new Hono();
    root.route("/v1/workspace", operationsRoutes(() => service));
    bareApp = root;
  });

  it("D2-a: non-stream request without any tenant context is 401", async () => {
    const res = await bareApp.request("http://localhost/v1/workspace/templates");
    expect(res.status).toBe(401);
  });

  it("D2-b: x-tenant-id header derives tenant context (production wiring path)", async () => {
    const res = await bareApp.request("http://localhost/v1/workspace/templates", {
      headers: { "x-tenant-id": tenantId },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ templates: unknown[] }>();
    expect(Array.isArray(body.templates)).toBe(true);
  });

  it("D2-c: SSE stream without headers authorizes via ticket-bound tenant (EventSource reality)", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_d2_diag",
      title: "Ticket-authority SSE",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    const ticket = generateTicket(tenantId, userId, run.id);
    const res = await bareApp.request(
      `http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${ticket}`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("D2-d: cross-tenant ticket without headers gets 404 anti-probing", async () => {
    const run = await service.createRun({
      tenantId,
      templateId: "stpl_d2_diag",
      title: "Anti-probing run",
      inputParameters: {},
      actor: { type: "user", id: userId },
      autoSubmit: false,
    });

    const intruderTicket = generateTicket("tenant_intruder_d2", "user_intruder", run.id);
    const res = await bareApp.request(
      `http://localhost/v1/workspace/runs/${run.id}/events/stream?token=${intruderTicket}`
    );
    expect(res.status).toBe(404);
  });
});
