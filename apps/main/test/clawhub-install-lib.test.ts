// F3: installClawHubSkill lib — version pin gates (F1 semantics), env-gated
// supply-chain source policy (OMA_SKILL_REQUIRE_VERIFIED, owner decision
// 2026-08-20: default off), sha256 pinned into the skill-version manifest.
// Fetch is injected so no live ClawHub calls happen in tests.

import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  installClawHubSkill,
  InstallValidationError,
  InstallSourceError,
  InstallNotFoundError,
  type ClawHubPackage,
} from "../src/lib/clawhub";

interface ZipEntry {
  name: string;
  content: string;
}

/** Build a real zip (local headers + central directory) so the shared
 *  controlled parser in lib/skill-zip can decode it. The previous
 *  hand-rolled local-header-only payload only worked because the
 *  install path used its own minimal parser — that parser is gone
 *  (P0 review 2026-08-20). */
function makeZip(entries: ZipEntry[]): ArrayBuffer {
  const obj: Record<string, Uint8Array> = {};
  for (const e of entries) obj[e.name] = strToU8(e.content);
  return zipSync(obj).buffer;
}

function makeFetch(pkg: Partial<ClawHubPackage> & { name: string }) {
  const meta: ClawHubPackage = {
    displayName: pkg.displayName ?? "Test Skill",
    summary: pkg.summary ?? "test",
    family: "skill",
    latestVersion: pkg.latestVersion ?? "1.0.0",
    ownerHandle: "oma",
    isOfficial: pkg.isOfficial ?? false,
    verificationTier: pkg.verificationTier ?? null,
    ...pkg,
  } as ClawHubPackage;
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.includes("/packages/")) {
      return new Response(JSON.stringify({ package: meta }), { status: 200 });
    }
    if (u.includes("/download")) {
      return new Response(makeZip([{ name: "SKILL.md", content: "# test skill\n" }]), { status: 200 });
    }
    if (u.includes("/packages")) {
      return new Response(JSON.stringify({ items: [meta] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeStores() {
  const kvPuts = new Map<string, string>();
  const blobPuts = new Map<string, Uint8Array>();
  return {
    kvPuts,
    blobPuts,
    kv: {
      put: async (k: string, v: string) => void kvPuts.set(k, v),
      get: async (k: string) => kvPuts.get(k) ?? null,
    },
    filesBlob: { put: async (k: string, v: Uint8Array) => void blobPuts.set(k, v) },
  };
}

const BASE = { tenantId: "t-test", slug: "test-skill" };

describe("installClawHubSkill version pin gates (F1/SDS §2.3)", () => {
  it("rejects missing version", async () => {
    const s = makeStores();
    await expect(
      installClawHubSkill({ ...BASE, version: "", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: makeFetch({ name: "x" }) }),
    ).rejects.toBeInstanceOf(InstallValidationError);
  });

  it("rejects version 'latest'", async () => {
    const s = makeStores();
    await expect(
      installClawHubSkill({ ...BASE, version: "latest", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: makeFetch({ name: "x" }) }),
    ).rejects.toBeInstanceOf(InstallValidationError);
  });

  it("unknown slug surfaces InstallNotFoundError (route maps 404)", async () => {
    const s = makeStores();
    const notFound = (async () => new Response("nf", { status: 404 })) as typeof fetch;
    await expect(
      installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: notFound }),
    ).rejects.toBeInstanceOf(InstallNotFoundError);
  });

  it("rejects package when Content-Length exceeds MAX_ZIP_DOWNLOAD_BYTES", async () => {
    const s = makeStores();
    const fetchWithBigCl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.includes("/packages/")) {
        return new Response(JSON.stringify({ package: { name: "test-skill", displayName: "Test", summary: "test", latestVersion: "1.0.0" } }), { status: 200 });
      }
      if (u.includes("/download")) {
        return new Response("dummy", {
          status: 200,
          headers: { "Content-Length": "20000000" }, // 20MB
        });
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;

    await expect(
      installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: fetchWithBigCl }),
    ).rejects.toBeInstanceOf(InstallValidationError);
  });
});

describe("installClawHubSkill supply-chain gate (SDS §2.4, env-gated)", () => {
  it("requireVerified=true + unverified tier → InstallSourceError (403)", async () => {
    const s = makeStores();
    await expect(
      installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: true, fetchImpl: makeFetch({ name: "test-skill", verificationTier: null }) }),
    ).rejects.toBeInstanceOf(InstallSourceError);
  });

  it("requireVerified=true + verified tier → passes", async () => {
    const s = makeStores();
    const res = await installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: true, fetchImpl: makeFetch({ name: "test-skill", verificationTier: "verified" }) });
    expect(res.id).toMatch(/^skill_/);
  });

  it("requireVerified=true + isOfficial → passes", async () => {
    const s = makeStores();
    const res = await installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: true, fetchImpl: makeFetch({ name: "test-skill", verificationTier: null, isOfficial: true }) });
    expect(res.id).toMatch(/^skill_/);
  });

  it("requireVerified=false + unverified → passes (pilot default, owner 2026-08-20)", async () => {
    const s = makeStores();
    const res = await installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: makeFetch({ name: "test-skill", verificationTier: null }) });
    expect(res.id).toMatch(/^skill_/);
  });
});

describe("installClawHubSkill sha256 pinning (SDS §2.4 hash write)", () => {
  it("writes hash into skillver manifest and returns it; skill record follows the kvKey format", async () => {
    const s = makeStores();
    const res = await installClawHubSkill({ ...BASE, version: "1.0.0", kv: s.kv, filesBlob: s.filesBlob, requireVerified: false, fetchImpl: makeFetch({ name: "test-skill" }) });

    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);

    const skillKey = `t:t-test:skill:${res.id}`;
    expect(s.kvPuts.has(skillKey)).toBe(true);
    const skill = JSON.parse(s.kvPuts.get(skillKey)!);
    expect(skill.clawhub_slug).toBe("test-skill");
    expect(skill.latest_version).toBe(res.latest_version);

    const verKey = `t:t-test:skillver:${res.id}:${res.latest_version}`;
    expect(s.kvPuts.has(verKey)).toBe(true);
    const ver = JSON.parse(s.kvPuts.get(verKey)!);
    expect(ver.hash).toBe(res.hash);
    expect(ver.files).toEqual([{ filename: "SKILL.md", size_bytes: expect.any(Number), encoding: "utf8" }]);

    // zip bytes land in the blob store under the skillFileR2Key layout
    expect([...s.blobPuts.keys()][0]).toContain(`t/t-test/skills/${res.id}/`);
  });
});

describe("installClawHubSkill idempotency (P2 review 2026-08-20)", () => {
  it("re-install of the same (slug, version) returns the existing skill + the same id", async () => {
    const s = makeStores();
    const args = {
      ...BASE,
      version: "1.0.0",
      kv: s.kv,
      filesBlob: s.filesBlob,
      requireVerified: false,
      fetchImpl: makeFetch({ name: "test-skill" }),
    };
    const first = await installClawHubSkill(args);
    const second = await installClawHubSkill(args);
    expect(second.id).toBe(first.id);
    expect(second.hash).toBe(first.hash);
    // Only ONE blob was written across the two attempts.
    const skillDirKeys = [...s.blobPuts.keys()].filter((k) => k.includes(`/skills/${first.id}/`));
    expect(skillDirKeys.length).toBe(1);
  });

  it("explicit idempotencyKey collapses retries to a single install", async () => {
    const s = makeStores();
    const baseArgs = {
      ...BASE,
      version: "1.0.0",
      kv: s.kv,
      filesBlob: s.filesBlob,
      requireVerified: false,
      fetchImpl: makeFetch({ name: "test-skill" }),
    };
    const a = await installClawHubSkill({ ...baseArgs, idempotencyKey: "retry-1" });
    const b = await installClawHubSkill({ ...baseArgs, idempotencyKey: "retry-1" });
    expect(b.id).toBe(a.id);
  });

  it("installing a DIFFERENT version (with different artifact bytes) produces a new id", async () => {
    // makeFetch returns the same content for every /download call (test
    // fixture simplicity); for THIS test we want different bytes per
    // version so the hash dedup lane doesn't collapse them. Override
    // fetchImpl to embed the version in the zip content.
    const fetchByVersion = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.includes("/packages/")) {
        return new Response(JSON.stringify({ package: { name: "test-skill", displayName: "Test Skill", summary: "test", family: "skill", latestVersion: "1.1.0", ownerHandle: "oma", isOfficial: false, verificationTier: null } }), { status: 200 });
      }
      if (u.includes("/download")) {
        // Pick content off the URL so different versions produce
        // different bytes → different sha256 → no hash dedup.
        const v = new URL(u, "http://x").searchParams.get("version") || "x";
        return new Response(zipSync({ "SKILL.md": strToU8(`# test skill ${v}\n`) }), { status: 200 });
      }
      if (u.includes("/packages")) {
        return new Response(JSON.stringify({ items: [{ name: "test-skill", displayName: "Test Skill", summary: "test", family: "skill", latestVersion: "1.1.0", ownerHandle: "oma", isOfficial: false, verificationTier: null }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const s = makeStores();
    const a = await installClawHubSkill({
      ...BASE,
      version: "1.0.0",
      kv: s.kv,
      filesBlob: s.filesBlob,
      requireVerified: false,
      fetchImpl: fetchByVersion,
    });
    const b = await installClawHubSkill({
      ...BASE,
      version: "1.1.0",
      kv: s.kv,
      filesBlob: s.filesBlob,
      requireVerified: false,
      fetchImpl: fetchByVersion,
    });
    expect(b.id).not.toBe(a.id);
    expect(b.hash).not.toBe(a.hash);
  });

  it("preserves source provenance on the persisted skill record", async () => {
    const s = makeStores();
    const res = await installClawHubSkill({
      ...BASE,
      version: "1.0.0",
      kv: s.kv,
      filesBlob: s.filesBlob,
      requireVerified: false,
      fetchImpl: makeFetch({ name: "test-skill", ownerHandle: "acme" }),
    });
    const skillRaw = s.kvPuts.get(`t:t-test:skill:${res.id}`)!;
    const skill = JSON.parse(skillRaw);
    expect(skill.source_version).toBe("1.0.0");
    expect(skill.source_owner).toBe("acme");
    expect(skill.source_verification_tier).toBeNull();
    expect(skill.source_url).toMatch(/^https:\/\/clawhub\.ai\/api\/v1\/download\?slug=test-skill&version=1\.0\.0$/);
  });
});
