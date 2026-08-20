// SDS v0.2 §1.6 / §3.2 — clawhub install must reject:
//   - missing `version` field
//   - `version: "latest"`
// And must accept an explicit pinned version (validated before any
// upstream fetch — the 400 path is the testable surface; the 201 path
// needs a real ClawHub stub which is out of scope here).
//
// We import the Hono sub-app DIRECTLY (not via SELF) to bypass
// authMiddleware — auth gating is verified by stream-auth.test.ts;
// this file proves the SCHEMA contract only.

import { describe, it, expect } from "vitest";
import clawhubApp from "../src/routes/clawhub";

interface ErrorBody {
  error?: string;
}

async function postInstall(body: unknown): Promise<Response> {
  return clawhubApp.request("/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("clawhub install · version pinning (SDS v0.2 §1.6)", () => {
  it("v-1: missing version → 400 with explicit 'version is required' message", async () => {
    const res = await postInstall({ slug: "deployment-kit" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toMatch(/version is required/);
  });

  it("v-2: missing slug AND missing version → 400 (slug checked first)", async () => {
    const res = await postInstall({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toMatch(/slug is required/);
  });

  it("v-3: version === 'latest' → 400 with explicit forbidden message", async () => {
    const res = await postInstall({ slug: "deployment-kit", version: "latest" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toMatch(/latest.*forbidden/);
  });

  it("v-4: explicit pinned version → reaches upstream fetch (502 expected, not 400)", async () => {
    // Pinned version must NOT be rejected at the schema gate. We expect
    // 502 (ClawHub is not reachable from workerd test) — the point is
    // that we got PAST the 400 gate. If the schema were over-strict,
    // we'd see 400 here.
    const res = await postInstall({ slug: "deployment-kit", version: "1.0.3" });
    expect(res.status).not.toBe(400);
    // Status is 502 (upstream fetch failed in test env) or 404 (ClawHub
    // returns not-found) — both prove we got past the schema check.
    expect([404, 502]).toContain(res.status);
  });
});
