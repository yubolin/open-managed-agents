// Shared ClawHub registry access. The public HTTP route (routes/clawhub.ts)
// and the SkillRpc service-binding entrypoint (index.ts) both go through
// this lib so the agent-side skill tools and /v1/clawhub/* return identical
// data and enforce identical policies.

import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { kvKey } from "../kv-helpers";
import { parseSkillZipBytesRaw, SkillZipError } from "./skill-zip";

export const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

export interface ClawHubPackage {
  name: string;
  displayName: string;
  summary: string;
  family: string;
  latestVersion: string;
  ownerHandle: string;
  /** ClawHub-side flags surfaced for supply-chain decisions. Enforcement is
   *  env-gated (OMA_SKILL_REQUIRE_VERIFIED, owner decision 2026-08-20:
   *  default off — ClawHub currently publishes no verified-tier packages);
   *  search only reports the facts. */
  isOfficial?: boolean;
  verificationTier?: string | null;
  stats?: { downloads?: number; installs?: number; stars?: number; versions?: number };
}

export interface ClawHubSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  is_official: boolean;
  verification_tier: string | null;
  downloads: number;
}

export async function searchClawHubSkills(
  q: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClawHubSkill[]> {
  const res = await fetchImpl(`${CLAWHUB_BASE}/packages${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (!res.ok) throw new Error(`ClawHub search failed: ${res.status}`);
  const body = (await res.json()) as { items: ClawHubPackage[] };
  const all = (body.items || [])
    .filter((p) => p.family === "skill")
    .map((p) => ({
      slug: p.name,
      name: p.displayName || p.name,
      description: p.summary || "",
      version: p.latestVersion,
      owner: p.ownerHandle,
      is_official: p.isOfficial ?? false,
      verification_tier: p.verificationTier ?? null,
      downloads: p.stats?.downloads ?? 0,
    }));

  // P1 review 2026-08-20: the upstream registry currently ignores `q`
  // and serves the same 25 items regardless of query. Filter locally
  // on slug/name/description so the tool never returns an irrelevant
  // result set, and cap the result count so the LLM context stays
  // bounded. Empty q = full catalog up to the cap.
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered =
    tokens.length === 0
      ? all
      : all.filter((s) => {
          const haystack = `${s.slug} ${s.name} ${s.description}`.toLowerCase();
          return tokens.every((t) => haystack.includes(t));
        });
  return filtered.slice(0, SEARCH_MAX_RESULTS);
}

/** Hard cap on results returned to the LLM. 50 is generous for the
 *  catalog size observed 2026-08-20 (ClawHub publishes ~25 skills)
 *  while keeping the tool result well under any reasonable context
 *  budget. */
export const SEARCH_MAX_RESULTS = 50;

/**
 * SDS agent-self-install §2.4 — supply-chain source policy.
 * OMA_SKILL_REQUIRE_VERIFIED=1 ("true" also accepted): only
 * verificationTier === "verified" (or isOfficial) packages may install.
 * Default off during pilot: ClawHub published 0 verified / 0 official
 * packages as of 2026-08-20, so strict enforcement would brick installs
 * (owner decision 2026-08-20). OMA_SKILL_WHITELIST_URLS declares
 * self-hosted source URLs; its enforcement lane ships when URL-based
 * install sources exist (current install path is ClawHub-only).
 */
export class InstallSourceError extends Error {}

export function parseRequireVerified(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export function assertInstallSourceAllowed(
  pkg: Pick<ClawHubPackage, "verificationTier" | "isOfficial">,
  requireVerified: boolean,
): void {
  if (!requireVerified) return;
  if (pkg.verificationTier === "verified" || pkg.isOfficial) return;
  throw new InstallSourceError(
    "package source not in whitelist: verificationTier is not 'verified' (OMA_SKILL_REQUIRE_VERIFIED is on)",
  );
}

/** Installed-skill record returned to callers (tool + HTTP route alike).
 *  `hash` is the sha256 of the downloaded zip artifact — pinned at install
 *  time into the KV skill-version manifest and re-checked by attach_skill
 *  (SDS §2.4: caller must pass the same hash at attach). */
export interface InstalledSkill {
  id: string;
  display_title: string;
  name: string;
  description: string;
  latest_version: string;
  clawhub_slug: string;
  hash: string;
}

/** Minimal structural deps so tests inject fakes without pulling the
 *  services package. Separated into SkillKvStore and SkillBlobWriter
 *  to conform with BlobStore and KV contracts without TS2322 errors. */
export interface SkillKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>;
}

export interface SkillBlobWriter {
  put(key: string, value: any, opts?: any): Promise<unknown>;
}

export const MAX_ZIP_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10MB cap on compressed package

async function readLimitedArrayBuffer(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const cl = res.headers.get("content-length");
  if (cl) {
    const declared = parseInt(cl, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new InstallValidationError(
        `Skill package exceeds maximum compressed size limit (${maxBytes} bytes)`,
      );
    }
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new InstallValidationError(
        `Skill package exceeds maximum compressed size limit (${maxBytes} bytes)`,
      );
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new InstallValidationError(
          `Skill package exceeds maximum compressed size limit (${maxBytes} bytes)`,
        );
      }
      chunks.push(value);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export class InstallValidationError extends Error {}
export class InstallNotFoundError extends Error {}
/** Deployment misconfiguration (e.g. FILES_BUCKET absent) — 500 lane.
 *  Deliberately checked AFTER version validation so schema errors keep
 *  their 400 precedence regardless of bucket state. */
export class InstallConfigError extends Error {}

/** Input validation for install (F1/SDS §2.3) — shared by the HTTP route
 *  (which must reject BEFORE touching request services, preserving 400
 *  precedence over 500 in middleware-less tests) and installClawHubSkill.
 *  Returns the error message, or null when input is valid. */
export function installInputError(slug: string, version: string): string | null {
  if (!slug) return "slug is required";
  if (!version) return "version is required (latest is not allowed; pass an explicit version)";
  if (version === "latest") return "version 'latest' is forbidden; pass an explicit version pin";
  return null;
}

async function deterministicSkillId(slug: string, version?: string): Promise<string> {
  const sanitizedSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 24);
  const rawKey = `${slug}@${version || "latest"}`;
  const hex = await sha256Hex(new TextEncoder().encode(rawKey));
  return `skill_ch_${sanitizedSlug}_${hex.slice(0, 12)}`;
}

/**
 * Install a ClawHub skill into the tenant's library: version must be an
 * explicit pin (never "latest" — F1/SDS §2.3), source must pass the
 * supply-chain gate, file bytes go to R2, manifest (incl. sha256 hash) to
 * KV. Throws InstallValidationError (caller → 400), InstallSourceError
 * (→ 403), Error (→ 502) — the HTTP route and SkillRpc map these to the
 * same statuses.
 *
 * Idempotency (P2 review 2026-08-20): if a caller passes
 * `idempotencyKey`, we look up `kvKey(tenant, "skillidem", key)` and
 * return the prior install when present — covering the "RPC succeeded
 * but the response was lost" retry case. With no explicit key we
 * derive one from `tenant:source:slug:source_version` so duplicate
 * installs of the same pinned artifact collapse to one Skill row.
 */
export async function installClawHubSkill(args: {
  tenantId: string;
  slug: string;
  version: string;
  kv: SkillKvStore;
  filesBlob: SkillBlobWriter | null;
  requireVerified: boolean;
  /** Optional caller-supplied retry token (UUID, hash, etc.). */
  idempotencyKey?: string;
  /** DI seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<InstalledSkill> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const inputError = installInputError(args.slug, args.version);
  if (inputError) throw new InstallValidationError(inputError);
  if (!args.filesBlob) throw new InstallConfigError("FILES_BUCKET binding not configured");

  // 0. Idempotency short-circuit — BEFORE any network call so a retried
  // request never re-downloads the zip or re-mints a skill id.
  const idemKey = args.idempotencyKey
    ? `key:${args.idempotencyKey}`
    : `src:${args.slug}:${args.version}`;
  const idemKvKey = kvKey(args.tenantId, "skillidem", idemKey);
  const existingId = await args.kv.get(idemKvKey);
  if (existingId) {
    const existingSkillRaw = await args.kv.get(kvKey(args.tenantId, "skill", existingId));
    if (existingSkillRaw) {
      const existing = JSON.parse(existingSkillRaw) as {
        id: string;
        display_title: string;
        name: string;
        description: string;
        latest_version: string;
        clawhub_slug: string;
      };
      const verRaw = await args.kv.get(
        kvKey(args.tenantId, "skillver", existingId, existing.latest_version),
      );
      const ver = verRaw ? (JSON.parse(verRaw) as { hash: string }) : null;
      return {
        id: existing.id,
        display_title: existing.display_title,
        name: existing.name,
        description: existing.description,
        latest_version: existing.latest_version,
        clawhub_slug: existing.clawhub_slug,
        hash: ver?.hash ?? "",
      };
    }
  }

  // 1. Package metadata + supply-chain gate
  const metaRes = await fetchImpl(`${CLAWHUB_BASE}/packages/${encodeURIComponent(args.slug)}`);
  if (!metaRes.ok) throw new InstallNotFoundError(`Skill "${args.slug}" not found on ClawHub`);
  const meta = (await metaRes.json()) as { package: ClawHubPackage };
  const pkg = meta.package;
  if (!pkg.latestVersion) {
    // Refuse if the package has no published version — fail loud rather
    // than guess (mirrors the pre-extraction route behaviour).
    throw new Error("ClawHub package has no published version");
  }
  assertInstallSourceAllowed(pkg, args.requireVerified);

  // 2. Download zip — check size limit before full extraction
  const dlRes = await fetchImpl(
    `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(args.slug)}&version=${encodeURIComponent(args.version)}`,
  );
  if (!dlRes.ok) throw new Error(`Failed to download skill: ${dlRes.status}`);
  const zipBuf = await readLimitedArrayBuffer(dlRes, MAX_ZIP_DOWNLOAD_BYTES);
  const hash = await sha256Hex(new Uint8Array(zipBuf));

  // Re-check the idempotency map AFTER the hash is computed — covers
  // the case where the prior attempt downloaded the same bytes but
  // crashed before writing the idem pointer.
  const existingByHash = await args.kv.get(
    kvKey(args.tenantId, "skillidem", `hash:${args.slug}:${hash}`),
  );
  if (existingByHash) {
    // Same pattern as above — return the existing record.
    const existingSkillRaw = await args.kv.get(
      kvKey(args.tenantId, "skill", existingByHash),
    );
    if (existingSkillRaw) {
      await args.kv.put(idemKvKey, existingByHash);
      const existing = JSON.parse(existingSkillRaw) as {
        id: string;
        display_title: string;
        name: string;
        description: string;
        latest_version: string;
        clawhub_slug: string;
      };
      return {
        id: existing.id,
        display_title: existing.display_title,
        name: existing.name,
        description: existing.description,
        latest_version: existing.latest_version,
        clawhub_slug: existing.clawhub_slug,
        hash,
      };
    }
  }

  // 3. Extract + persist via the shared controlled ZIP parser
  let parsed;
  try {
    parsed = parseSkillZipBytesRaw(new Uint8Array(zipBuf));
  } catch (err) {
    if (err instanceof SkillZipError) {
      // Map parser errors to validation lane — caller surfaces as 400.
      throw new InstallValidationError(err.message);
    }
    throw err;
  }
  const files = parsed.files;
  if (files.length === 0) throw new Error("Downloaded zip contains no files");

  const skillName = (pkg.displayName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const id = await deterministicSkillId(args.slug, args.version);
  const versionId = args.version || Date.now().toString();
  const now = new Date().toISOString();

  // Write file contents to R2 first
  const manifest: Array<{ filename: string; size_bytes: number; encoding: "utf8" | "base64" }> = [];
  for (const f of files) {
    await args.filesBlob.put(skillFileR2Key(args.tenantId, id, versionId, f.filename), f.bytes);
    manifest.push({ filename: f.filename, size_bytes: f.bytes.byteLength, encoding: f.encoding });
  }

  const skill = {
    id,
    display_title: pkg.displayName || pkg.name,
    name: skillName,
    description: parsed.description ?? pkg.summary ?? "",
    source: "custom" as const,
    latest_version: versionId,
    created_at: now,
    clawhub_slug: args.slug,
    source_version: args.version,
    source_owner: pkg.ownerHandle,
    source_verification_tier: pkg.verificationTier ?? null,
    source_url: `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(args.slug)}&version=${encodeURIComponent(args.version)}`,
  };
  const version = { version: versionId, files: manifest, created_at: now, hash };

  // Write version manifest first, then main skill record, then idempotency pointers
  await args.kv.put(kvKey(args.tenantId, "skillver", id, versionId), JSON.stringify(version));
  await args.kv.put(kvKey(args.tenantId, "skill", id), JSON.stringify(skill));
  await Promise.all([
    args.kv.put(idemKvKey, id),
    args.kv.put(kvKey(args.tenantId, "skillidem", `hash:${args.slug}:${hash}`), id),
  ]);

  return { ...skill, hash };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
