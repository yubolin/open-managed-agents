// F7: Node custom-skill gate (SDS agent-self-install §2.7).
// Node has no SKILL_RPC / R2 / KV manifest lane, so an agent carrying
// skills[].type === "custom" cannot be resolved at session-build time.
// The Node mount must reject such writes with an explicit 501 (+ runtime
// marker) instead of accepting a row the runtime can never serve — the
// same "no silent fakes" contract as the main-node 501 stubs.
//   - create with a custom skill  → 501
//   - update (attach lane) ditto  → 501
//   - non-custom skill types      → unaffected
//   - default mount (CF)          → custom skills stay allowed

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "../src/agents";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

function makeApp(allowCustomSkills?: boolean) {
  const { service } = createInMemoryAgentService();
  const agentsApp = buildAgentRoutes({
    services: { agents: service } as never,
    ...(allowCustomSkills === undefined ? {} : { allowCustomSkills }),
  });
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

const CUSTOM_SKILL = [{ skill_id: "skill_x", type: "custom", version: "1.0.3" }];
const BUILTIN_SKILL = [{ skill_id: "search", type: "builtin" }];

function jsonInit(body: Record<string, unknown>, method = "POST"): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

describe("custom-skill gate when allowCustomSkills=false (Node mount, SDS §2.7)", () => {
  it("create with skills[].type=custom → 501 + runtime marker", async () => {
    const app = makeApp(false);
    const res = await app.request(
      "/",
      jsonInit({ name: "a1", model: "claude-sonnet-5", skills: CUSTOM_SKILL }),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; runtime: string };
    expect(body.error).toMatch(/custom skill/i);
    expect(body.runtime).toBe("node");
  });

  it("update (attach lane) adding a custom skill → 501", async () => {
    const app = makeApp(false);
    const created = await app.request(
      "/",
      jsonInit({ name: "a1", model: "claude-sonnet-5" }),
    );
    expect(created.status).toBe(201);
    const { id, version } = (await created.json()) as { id: string; version: number };

    const res = await app.request(
      `/${id}`,
      jsonInit({ skills: CUSTOM_SKILL, version }, "PUT"),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { runtime: string };
    expect(body.runtime).toBe("node");
  });

  it("non-custom skill types pass through", async () => {
    const app = makeApp(false);
    const res = await app.request(
      "/",
      jsonInit({ name: "a1", model: "claude-sonnet-5", skills: BUILTIN_SKILL }),
    );
    expect(res.status).toBe(201);
  });

  it("default mount (no flag) keeps custom skills allowed — CF lane unchanged", async () => {
    const app = makeApp();
    const res = await app.request(
      "/",
      jsonInit({ name: "a1", model: "claude-sonnet-5", skills: CUSTOM_SKILL }),
    );
    expect(res.status).toBe(201);
  });
});
