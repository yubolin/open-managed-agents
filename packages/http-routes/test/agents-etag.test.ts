// F6: agent update etag protocol (SDS agent-self-install §2.5).
// The agent row's `version` is the concurrency token (If-Match role):
//   - update WITHOUT version → 428 Precondition Required
//   - update with STALE version → 409 (existing AgentVersionMismatchError
//     mapping; body must tell the caller what happened)
//   - update with current version → 200, version bumps by 1
// Retry-once itself lives in skillAttach (F4, apps/main lib test) — this
// file pins the HTTP-lane contract both CF and Node mounts share.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "../src/agents";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function makeApp() {
  const { service } = createInMemoryAgentService();
  const agentsApp = buildAgentRoutes({ services: { agents: service } as never });
  // Direct app.request() bypasses platform middleware — wrap with the
  // tenant_id setter the real mounts provide.
  const root = new Hono<Vars>();
  root.use("*", async (c, next) => {
    c.set("tenant_id", "t-test");
    await next();
  });
  root.route("/", agentsApp);
  return root;
}

async function createAgent(app: Hono<Vars>): Promise<{ id: string; version: number }> {
  const res = await app.request("/", {
    method: "POST",
    body: JSON.stringify({ name: "a1", model: "claude-sonnet-5" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; version: number };
  return { id: body.id, version: body.version };
}

function updateInit(body: Record<string, unknown>): RequestInit {
  return {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

describe("PUT /v1/agents/:id optimistic concurrency (SDS §2.5)", () => {
  it("missing version → 428 Precondition Required", async () => {
    const app = makeApp();
    const { id } = await createAgent(app);
    const res = await app.request(`/${id}`, updateInit({ name: "renamed" }));
    expect(res.status).toBe(428);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/version/i);
  });

  it("stale version → 409", async () => {
    const app = makeApp();
    const { id, version } = await createAgent(app);
    // First update bumps version to version+1…
    const first = await app.request(`/${id}`, updateInit({ name: "v2", version }));
    expect(first.status).toBe(200);
    // …so the ORIGINAL version is now stale.
    const stale = await app.request(`/${id}`, updateInit({ name: "v3", version }));
    expect(stale.status).toBe(409);
  });

  it("current version → 200 and version bumps", async () => {
    const app = makeApp();
    const { id, version } = await createAgent(app);
    const res = await app.request(`/${id}`, updateInit({ name: "v2", version }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(version + 1);
  });
});
