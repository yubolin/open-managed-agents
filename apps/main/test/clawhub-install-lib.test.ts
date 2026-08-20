// F3: installClawHubSkill lib — version pin gates (F1 semantics), env-gated
// supply-chain source policy (OMA_SKILL_REQUIRE_VERIFIED, owner decision
// 2026-08-20: default off), sha256 pinned into the skill-version manifest.
// Fetch is injected so no live ClawHub calls happen in tests.

import { describe, it, expect } from "vitest";
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

/** Hand-rolled stored (method 0) zip — the extractor only walks local file
 *  headers, so no central directory is needed. */
function makeZip(entries: ZipEntry[]): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const dataBytes = enc.encode(e.content);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header sig
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0, true); // flags
    header.setUint16(8, 0, true); // method: store
    header.setUint32(14, 0, true); // crc32 (extractor ignores)
    header.setUint32(18, dataBytes.byteLength, true); // compressed size
    header.setUint32(22, dataBytes.byteLength, true); // uncompressed size
    header.setUint16(26, nameBytes.byteLength, true);
    header.setUint16(28, 0, true); // extra len
    parts.push(new Uint8Array(header.buffer), nameBytes, dataBytes);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
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
    kv: { put: async (k: string, v: string) => void kvPuts.set(k, v) },
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
