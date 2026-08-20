import type { AgentService } from "@open-managed-agents/agents-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { unzipSync } from "fflate";

export const CLAWHUB_BASE = "https://clawhub.ai/api/v1";
export const CONFIRMATION_TTL_SECONDS = 60;
export const MAX_ZIP_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10MB

export interface ConfirmationBinding {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  canonicalInput: unknown;
}

export class ConfirmationRequiredError extends Error {
  constructor(message = "confirmation required or expired") {
    super(message);
  }
}

export class InstallValidationError extends Error {}
export class InstallNotFoundError extends Error {}
export class InstallSourceError extends Error {}
export class InstallConfigError extends Error {}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJsonStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bindingHash(binding: ConfirmationBinding): Promise<string> {
  const enc = new TextEncoder().encode(canonicalJsonStringify(binding));
  return sha256Hex(enc);
}

async function deterministicSkillId(slug: string, version?: string): Promise<string> {
  const sanitizedSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 24);
  const rawKey = `${slug}@${version || "latest"}`;
  const hex = await sha256Hex(new TextEncoder().encode(rawKey));
  return `skill_ch_${sanitizedSlug}_${hex.slice(0, 12)}`;
}

export async function mintSkillConfirmation(args: {
  kv: KvStore;
  tenantId: string;
  purpose: "install" | "attach";
  binding: ConfirmationBinding;
}): Promise<{ token: string; expires_in: number }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const payload = {
    purpose: args.purpose,
    session_id: args.binding.sessionId,
    tool_use_id: args.binding.toolUseId,
    tool_name: args.binding.toolName,
    canonical_input_hash: await bindingHash(args.binding),
  };
  await args.kv.put(
    `t:${args.tenantId}:skillconf:${token}`,
    JSON.stringify(payload),
    { expirationTtl: CONFIRMATION_TTL_SECONDS },
  );
  return { token, expires_in: CONFIRMATION_TTL_SECONDS };
}

export async function consumeSkillConfirmation(args: {
  kv: KvStore;
  tenantId: string;
  token: string | undefined;
  purpose: "install" | "attach";
  binding?: ConfirmationBinding;
}): Promise<void> {
  if (!args.token) throw new ConfirmationRequiredError();
  const key = `t:${args.tenantId}:skillconf:${args.token}`;
  const raw = await args.kv.get(key);
  if (!raw) throw new ConfirmationRequiredError();
  const parsed = JSON.parse(raw) as {
    purpose?: string;
    session_id?: string;
    tool_use_id?: string;
    tool_name?: string;
    canonical_input_hash?: string;
  };
  if (parsed.purpose !== args.purpose) throw new ConfirmationRequiredError();
  if (parsed.canonical_input_hash) {
    if (!args.binding) throw new ConfirmationRequiredError();
    if (parsed.session_id !== args.binding.sessionId) throw new ConfirmationRequiredError();
    if (parsed.tool_use_id !== args.binding.toolUseId) throw new ConfirmationRequiredError();
    if (parsed.tool_name !== args.binding.toolName) throw new ConfirmationRequiredError();
    const provided = await bindingHash(args.binding);
    if (provided !== parsed.canonical_input_hash) throw new ConfirmationRequiredError();
  } else if (args.binding) {
    throw new ConfirmationRequiredError();
  }
  await args.kv.delete(key);
}

export async function skillConfirmationGuard(args: {
  kv: KvStore;
  tenantId: string;
  token: string | undefined;
  purpose: "install" | "attach";
  binding?: ConfirmationBinding;
  adminAllowlist?: string;
}): Promise<void> {
  const allow = (args.adminAllowlist || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(args.tenantId)) return;
  await consumeSkillConfirmation(args);
}

export interface ClawHubPackage {
  name: string;
  displayName: string;
  summary: string;
  family: string;
  latestVersion: string;
  ownerHandle: string;
  isOfficial?: boolean;
  verificationTier?: string | null;
  stats?: { downloads?: number; installs?: number; stars?: number; versions?: number };
}

export async function searchClawHubSkills(
  q: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
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

  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered =
    tokens.length === 0
      ? all
      : all.filter((s) => {
          const haystack = `${s.slug} ${s.name} ${s.description}`.toLowerCase();
          return tokens.every((t) => haystack.includes(t));
        });
  return filtered.slice(0, 50);
}

export interface NodeSkillRpcOptions {
  agents: AgentService;
  filesBlob: BlobStore;
  kv: KvStore;
  adminAllowlist?: string;
  requireVerified?: string;
}

export function createNodeSkillRpc(opts: NodeSkillRpcOptions) {
  return {
    async skillSearch(args: { tenantId: string; q?: string }): Promise<
      | { status: 200; results: Array<Record<string, unknown>> }
      | { status: number; error: string }
    > {
      try {
        const results = await searchClawHubSkills(args.q || "");
        return { status: 200, results };
      } catch (err) {
        return {
          status: 502,
          error: err instanceof Error ? err.message : "ClawHub search failed",
        };
      }
    },

    async skillInstall(args: {
      tenantId: string;
      slug: string;
      version: string;
      confirmationToken?: string;
      binding?: ConfirmationBinding;
    }): Promise<
      | { status: 201; skill: Record<string, unknown> }
      | { status: number; error: string }
    > {
      try {
        if (!args.slug) throw new InstallValidationError("slug is required");
        if (!args.version || args.version === "latest") {
          throw new InstallValidationError("explicit version pin required (not 'latest')");
        }
        await skillConfirmationGuard({
          kv: opts.kv,
          tenantId: args.tenantId,
          token: args.confirmationToken,
          purpose: "install",
          binding: args.binding,
          adminAllowlist: opts.adminAllowlist,
        });

        // 1. Fetch metadata
        const metaRes = await fetch(`${CLAWHUB_BASE}/packages/${encodeURIComponent(args.slug)}`);
        if (!metaRes.ok) throw new InstallNotFoundError(`Skill "${args.slug}" not found on ClawHub`);
        const meta = (await metaRes.json()) as { package: ClawHubPackage };
        const pkg = meta.package;

        // 2. Download zip
        const dlRes = await fetch(
          `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(args.slug)}&version=${encodeURIComponent(args.version)}`,
        );
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
        const buf = await dlRes.arrayBuffer();
        if (buf.byteLength > MAX_ZIP_DOWNLOAD_BYTES) {
          throw new InstallValidationError("Skill package exceeds 10MB limit");
        }
        const hash = await sha256Hex(new Uint8Array(buf));

        // 3. Extract zip files using fflate
        const unzipped = unzipSync(new Uint8Array(buf));
        const id = await deterministicSkillId(args.slug, args.version);
        const versionId = args.version;
        const now = new Date().toISOString();

        const manifest: Array<{ filename: string; size_bytes: number; encoding: "utf8" | "base64" }> = [];
        for (const [filename, fileBytes] of Object.entries(unzipped)) {
          if (!filename || filename.endsWith("/") || filename.includes("..")) continue;
          await opts.filesBlob.put(skillFileR2Key(args.tenantId, id, versionId, filename), fileBytes);
          manifest.push({ filename, size_bytes: fileBytes.byteLength, encoding: "utf8" });
        }

        const skillName = (pkg.displayName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
        const skill = {
          id,
          display_title: pkg.displayName || pkg.name,
          name: skillName,
          description: pkg.summary ?? "",
          source: "custom" as const,
          latest_version: versionId,
          created_at: now,
          clawhub_slug: args.slug,
          source_version: args.version,
          source_owner: pkg.ownerHandle,
        };
        const version = { version: versionId, files: manifest, created_at: now, hash };

        await opts.kv.put(`t:${args.tenantId}:skillver:${id}:${versionId}`, JSON.stringify(version));
        await opts.kv.put(`t:${args.tenantId}:skill:${id}`, JSON.stringify(skill));

        return { status: 201, skill: { ...skill, hash } };
      } catch (err) {
        if (err instanceof ConfirmationRequiredError) return { status: 403, error: err.message };
        if (err instanceof InstallValidationError) return { status: 400, error: err.message };
        if (err instanceof InstallSourceError) return { status: 403, error: err.message };
        if (err instanceof InstallNotFoundError) return { status: 404, error: err.message };
        if (err instanceof InstallConfigError) return { status: 500, error: err.message };
        return { status: 502, error: err instanceof Error ? err.message : "install failed" };
      }
    },

    async skillAttach(args: {
      tenantId: string;
      agentId: string;
      skillId: string;
      version: string;
      hash: string;
      confirmationToken?: string;
      binding?: ConfirmationBinding;
    }): Promise<
      | {
          status: 200;
          attached: {
            new_session_required: true;
            skill_id: string;
            version: string;
            agent_version: number;
          };
        }
      | { status: number; error: string }
    > {
      try {
        await skillConfirmationGuard({
          kv: opts.kv,
          tenantId: args.tenantId,
          token: args.confirmationToken,
          purpose: "attach",
          binding: args.binding,
          adminAllowlist: opts.adminAllowlist,
        });

        const verRaw = await opts.kv.get(`t:${args.tenantId}:skillver:${args.skillId}:${args.version}`);
        if (!verRaw) {
          return { status: 404, error: `Skill "${args.skillId}" version "${args.version}" not found` };
        }
        const ver = JSON.parse(verRaw) as { hash: string };
        if (ver.hash !== args.hash) {
          return { status: 409, error: "Skill hash mismatch vs install-time pin" };
        }

        const agent = await opts.agents.get({ tenantId: args.tenantId, agentId: args.agentId });
        if (!agent) {
          return { status: 404, error: `Agent "${args.agentId}" not found` };
        }

        const existingSkills = (agent.skills || []) as Array<{ skill_id?: string; [k: string]: unknown }>;
        const nextSkills = [
          ...existingSkills.filter((s) => s.skill_id !== args.skillId),
          { type: "custom", skill_id: args.skillId, version: args.version },
        ];

        const updated = await opts.agents.update({
          tenantId: args.tenantId,
          agentId: args.agentId,
          input: { skills: nextSkills as never },
        });

        return {
          status: 200,
          attached: {
            new_session_required: true,
            skill_id: args.skillId,
            version: args.version,
            agent_version: updated.version,
          },
        };
      } catch (err) {
        if (err instanceof ConfirmationRequiredError) return { status: 403, error: err.message };
        return { status: 500, error: err instanceof Error ? err.message : "attach failed" };
      }
    },
  };
}
