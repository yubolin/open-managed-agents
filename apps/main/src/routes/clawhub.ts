import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  CLAWHUB_BASE,
  searchClawHubSkills,
  installClawHubSkill,
  installInputError,
  InstallValidationError,
  InstallSourceError,
  InstallNotFoundError,
  InstallConfigError,
  type ClawHubPackage,
} from "../lib/clawhub";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>();

// GET /v1/clawhub/search?q=xxx — search ClawHub registry
app.get("/search", async (c) => {
  try {
    return c.json({ data: await searchClawHubSkills(c.req.query("q") || "") });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "ClawHub search failed" }, 502);
  }
});

// POST /v1/clawhub/install — install a skill from ClawHub
//
// SDS v0.2 §1.6 / §3.2: `version` is REQUIRED and must be explicit.
// "latest" is forbidden — callers must pin a version so installs are
// reproducible and the sha256 hash pinned at install time can be
// re-checked at attach time. Backwards-incompatible with v0.1 callers
// that omitted the field; update `oma skills install <slug> <version>`.
//
// Supply-chain gate: OMA_SKILL_REQUIRE_VERIFIED=1 restricts installs to
// ClawHub verified-tier / official packages (default off — see lib/clawhub.ts).
app.post("/install", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ slug?: string; version?: string }>();

  // Input gates run BEFORE any services access — preserves 400 precedence
  // over 500/502 regardless of middleware state (single source of truth:
  // lib installInputError, re-checked inside installClawHubSkill).
  const inputError = installInputError(body.slug || "", body.version || "");
  if (inputError) return c.json({ error: inputError }, 400);

  try {
    const installed = await installClawHubSkill({
      tenantId: t,
      slug: body.slug || "",
      version: body.version || "",
      kv: c.var.services.kv,
      filesBlob: c.var.services.filesBlob ?? null,
      requireVerified: parseReqVerified(c.env),
    });
    return c.json(installed, 201);
  } catch (err) {
    if (err instanceof InstallValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof InstallSourceError) return c.json({ error: err.message }, 403);
    if (err instanceof InstallNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof InstallConfigError) return c.json({ error: err.message }, 500);
    return c.json({ error: err instanceof Error ? err.message : "install failed" }, 502);
  }
});

function parseReqVerified(env: { OMA_SKILL_REQUIRE_VERIFIED?: string }): boolean {
  return env.OMA_SKILL_REQUIRE_VERIFIED === "1" || env.OMA_SKILL_REQUIRE_VERIFIED === "true";
}

export default app;
export { CLAWHUB_BASE };
export type { ClawHubPackage };
