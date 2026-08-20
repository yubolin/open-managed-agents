// Shared ClawHub registry access. The public HTTP route (routes/clawhub.ts)
// and the SkillRpc service-binding entrypoint (index.ts) both go through
// this lib so the agent-side skill tools and /v1/clawhub/* return identical
// data and enforce identical policies.

import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import { kvKey } from "../kv-helpers";

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

export async function searchClawHubSkills(q: string): Promise<ClawHubSkill[]> {
  const res = await fetch(`${CLAWHUB_BASE}/packages${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (!res.ok) throw new Error(`ClawHub search failed: ${res.status}`);
  const body = (await res.json()) as { items: ClawHubPackage[] };
  return (body.items || [])
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
}

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
 *  services package. Shape matches Services.kv / Services.filesBlob put(). */
interface PutOnlyStore {
  put(key: string, value: string | Uint8Array): Promise<unknown>;
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

/**
 * Install a ClawHub skill into the tenant's library: version must be an
 * explicit pin (never "latest" — F1/SDS §2.3), source must pass the
 * supply-chain gate, file bytes go to R2, manifest (incl. sha256 hash) to
 * KV. Throws InstallValidationError (caller → 400), InstallSourceError
 * (→ 403), Error (→ 502) — the HTTP route and SkillRpc map these to the
 * same statuses.
 */
export async function installClawHubSkill(args: {
  tenantId: string;
  slug: string;
  version: string;
  kv: PutOnlyStore;
  filesBlob: PutOnlyStore | null;
  requireVerified: boolean;
  /** DI seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<InstalledSkill> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const inputError = installInputError(args.slug, args.version);
  if (inputError) throw new InstallValidationError(inputError);
  if (!args.filesBlob) throw new InstallConfigError("FILES_BUCKET binding not configured");

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

  // 2. Download zip — hash the artifact AS DISTRIBUTED before extraction
  const dlRes = await fetchImpl(
    `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(args.slug)}&version=${encodeURIComponent(args.version)}`,
  );
  if (!dlRes.ok) throw new Error(`Failed to download skill: ${dlRes.status}`);
  const zipBuf = await dlRes.arrayBuffer();
  const hash = await sha256Hex(new Uint8Array(zipBuf));

  // 3. Extract + persist
  const files = await extractZipFiles(zipBuf);
  if (files.length === 0) throw new Error("Downloaded zip contains no files");

  const skillName = (pkg.displayName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();
  const now = new Date().toISOString();

  const manifest: Array<{ filename: string; size_bytes: number; encoding: "utf8" }> = [];
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content);
    await args.filesBlob.put(skillFileR2Key(args.tenantId, id, versionId, f.filename), bytes);
    manifest.push({ filename: f.filename, size_bytes: bytes.byteLength, encoding: "utf8" });
  }

  const skill = {
    id,
    display_title: pkg.displayName || pkg.name,
    name: skillName,
    description: pkg.summary || "",
    source: "custom" as const,
    latest_version: versionId,
    created_at: now,
    clawhub_slug: args.slug,
  };
  // skill_versions manifest carries the pinned sha256 — attach_skill (F4)
  // re-checks the caller's hash against this value.
  const version = { version: versionId, files: manifest, created_at: now, hash };

  await Promise.all([
    args.kv.put(kvKey(args.tenantId, "skill", id), JSON.stringify(skill)),
    args.kv.put(kvKey(args.tenantId, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  return { ...skill, hash };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract text files from a zip ArrayBuffer.
 * Minimal zip parser — handles Store (0) and Deflate (8) methods.
 */
async function extractZipFiles(buf: ArrayBuffer): Promise<Array<{ filename: string; content: string }>> {
  const view = new DataView(buf);
  const files: Array<{ filename: string; content: string }> = [];
  let offset = 0;

  while (offset < buf.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = new Uint8Array(buf, offset + 30, nameLen);
    const filename = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = new Uint8Array(buf, dataStart, compressedSize);

    if (!filename.endsWith("/") && !filename.startsWith("__MACOSX")) {
      try {
        let content: string;
        if (compressionMethod === 8) {
          // Deflate
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(rawData).catch((err) => {
            logWarn({ op: "clawhub.zip.deflate_write", err }, "deflate write failed");
          });
          writer.close().catch((err) => {
            logWarn({ op: "clawhub.zip.deflate_close", err }, "deflate close failed");
          });
          const decompressed = new Response(ds.readable);
          content = await decompressed.text();
        } else {
          content = new TextDecoder().decode(rawData);
        }
        files.push({ filename, content });
      } catch (err) {
        // Skip files that fail to decompress — preserve the rest of the zip.
        logWarn(
          { op: "clawhub.zip.entry_decompress", filename, err },
          "skipped unreadable zip entry",
        );
      }
    }

    offset = dataStart + compressedSize;
  }

  return files;
}
