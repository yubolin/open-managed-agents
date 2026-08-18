import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { operationsApi } from "../src/lib/api";

describe("Base D · Operations API Client Suite", () => {
  const originalFetch = globalThis.fetch;
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    store.set("openma_tenant_id", "tenant_test_custom");
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, val),
      clear: () => store.clear(),
      removeItem: (key: string) => store.delete(key),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).localStorage;
  });

  it("1. getTemplates: formats query params and injects tenant header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ templates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await operationsApi.getTemplates("diagnostic");
    expect(res.templates).toEqual([]);
    expect(capturedUrl).toBe("/v1/workspace/templates?category=diagnostic");
    expect(capturedHeaders?.get("x-tenant-id")).toBe("tenant_test_custom");
  });

  it("2. createRun: posts payload with content-type and returns run", async () => {
    let capturedMethod = "";
    let capturedBody = "";

    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method || "";
      capturedBody = (init?.body as string) || "";
      return new Response(
        JSON.stringify({
          run: {
            id: "run_test_123",
            tenant_id: "tenant_test_custom",
            title: "Test Run",
            state: "draft",
            service_template_id: "stpl_diag",
            template_version_id: "stplv_1",
            current_approval_stage: 0,
            created_by: "user_operator_bob",
            input_parameters: { host: "10.0.0.1" },
            created_at: 1000,
            updated_at: 1000,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });

    const res = await operationsApi.createRun({
      template_id: "stpl_diag",
      template_version_id: "stplv_1",
      title: "Test Run",
      input_parameters: { host: "10.0.0.1" },
      auto_submit: true,
    });

    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({
      template_id: "stpl_diag",
      template_version_id: "stplv_1",
      title: "Test Run",
      input_parameters: { host: "10.0.0.1" },
      auto_submit: true,
    });
    expect(res.run.id).toBe("run_test_123");
    expect(res.run.state).toBe("draft");
  });

  it("3. approveRun & rejectRun: post decisions correctly", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = (init?.body as string) || "";
      return new Response(
        JSON.stringify({
          run: {
            id: "run_appr_1",
            state: "approved",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await operationsApi.approveRun("run_appr_1", { comment: "Looks good" });
    expect(capturedUrl).toBe("/v1/workspace/runs/run_appr_1/approve");
    expect(JSON.parse(capturedBody)).toEqual({ comment: "Looks good" });

    await operationsApi.rejectRun("run_appr_1", { action: "request_changes", comment: "Needs fix" });
    expect(capturedUrl).toBe("/v1/workspace/runs/run_appr_1/reject");
    expect(JSON.parse(capturedBody)).toEqual({ action: "request_changes", comment: "Needs fix" });
  });

  it("4. createAuthTicket: requests 30s ticket with run_id binding", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = (init?.body as string) || "";
      return new Response(
        JSON.stringify({
          ticket: "ticket_abc123",
          expires_in_seconds: 30,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const res = await operationsApi.createAuthTicket({ run_id: "run_test_live" });
    expect(capturedUrl).toBe("/v1/workspace/auth/ticket");
    expect(JSON.parse(capturedBody)).toEqual({ run_id: "run_test_live" });
    expect(res.ticket).toBe("ticket_abc123");
    expect(res.expires_in_seconds).toBe(30);
  });

  it("5. Error handling: parses server error JSON into Error message", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "SOD_VIOLATION_SELF_APPROVAL_FORBIDDEN",
          code: "FORBIDDEN",
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    });

    await expect(operationsApi.approveRun("run_self_1")).rejects.toThrow(
      "SOD_VIOLATION_SELF_APPROVAL_FORBIDDEN"
    );
  });
});
