// F5: confirmation_token lib (SDS §2.2) — one-time use, TTL 60s,
// purpose-bound, admin-tenant bypass via OMA_SKILL_ADMIN_ALLOWLIST.
// Failure mode is uniformly 403 "confirmation required or expired".

import { describe, it, expect } from "vitest";
import {
  mintSkillConfirmation,
  consumeSkillConfirmation,
  skillConfirmationGuard,
  ConfirmationRequiredError,
  CONFIRMATION_TTL_SECONDS,
} from "../src/lib/skill-confirmation";

/** In-memory KvStore fake with real TTL semantics (wall-clock expiry). */
function makeKv(nowMs = () => Date.now()) {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  return {
    store,
    kv: {
      get: async (key: string) => {
        const e = store.get(key);
        if (!e) return null;
        if (e.expiresAtMs !== null && e.expiresAtMs <= nowMs()) return null;
        return e.value;
      },
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, {
          value,
          expiresAtMs: opts?.expirationTtl ? nowMs() + opts.expirationTtl * 1000 : null,
        });
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  };
}

describe("mintSkillConfirmation", () => {
  it("mints a 64-hex token with 60s TTL and purpose bound", async () => {
    const { kv, store } = makeKv();
    const res = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.expires_in).toBe(CONFIRMATION_TTL_SECONDS);
    expect(CONFIRMATION_TTL_SECONDS).toBe(60);
    const entry = store.get(`t:t-test:skillconf:${res.token}`);
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.value).purpose).toBe("install");
  });

  it("two mints produce distinct tokens", async () => {
    const { kv } = makeKv();
    const a = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    const b = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    expect(a.token).not.toBe(b.token);
  });
});

describe("consumeSkillConfirmation (SDS §2.2 acceptance)", () => {
  it("missing token → 403 lane (ConfirmationRequiredError)", async () => {
    const { kv } = makeKv();
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token: "", purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token: undefined, purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("valid token consumes successfully; SECOND use → 403 (one-time)", async () => {
    const { kv } = makeKv();
    const { token } = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token, purpose: "install" }),
    ).resolves.toBeUndefined();
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token, purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("expired token (TTL 60s) → 403", async () => {
    let clock = 1_000_000;
    const { kv } = makeKv(() => clock);
    const { token } = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    clock += 61_000; // past the 60s window
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token, purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("purpose mismatch (install token on attach) → 403", async () => {
    const { kv } = makeKv();
    const { token } = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "install" });
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-test", token, purpose: "attach" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("cross-tenant token → 403 (tenant-scoped keys)", async () => {
    const { kv } = makeKv();
    const { token } = await mintSkillConfirmation({ kv, tenantId: "t-a", purpose: "install" });
    await expect(
      consumeSkillConfirmation({ kv, tenantId: "t-b", token, purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("never-minted garbage token → 403", async () => {
    const { kv } = makeKv();
    await expect(
      consumeSkillConfirmation({
        kv,
        tenantId: "t-test",
        token: "f".repeat(64),
        purpose: "install",
      }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });
});

describe("skillConfirmationGuard admin bypass (OMA_SKILL_ADMIN_ALLOWLIST)", () => {
  it("allowlisted tenant passes WITHOUT a token", async () => {
    const { kv } = makeKv();
    await expect(
      skillConfirmationGuard({
        kv,
        tenantId: "t-ops",
        token: "",
        purpose: "install",
        adminAllowlist: "t-ops, t-ops2",
      }),
    ).resolves.toBeUndefined();
  });

  it("non-allowlisted tenant still requires a valid token", async () => {
    const { kv } = makeKv();
    await expect(
      skillConfirmationGuard({
        kv,
        tenantId: "t-test",
        token: "",
        purpose: "install",
        adminAllowlist: "t-ops",
      }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("empty/undefined allowlist = no bypass", async () => {
    const { kv } = makeKv();
    await expect(
      skillConfirmationGuard({ kv, tenantId: "t-test", token: "", purpose: "install" }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it("non-allowlisted tenant with valid token passes (normal path)", async () => {
    const { kv } = makeKv();
    const { token } = await mintSkillConfirmation({ kv, tenantId: "t-test", purpose: "attach" });
    await expect(
      skillConfirmationGuard({
        kv,
        tenantId: "t-test",
        token,
        purpose: "attach",
        adminAllowlist: "t-ops",
      }),
    ).resolves.toBeUndefined();
  });
});
