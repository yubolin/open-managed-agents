// Shared ClawHub registry access. Both the public HTTP route
// (routes/clawhub.ts) and the SkillRpc service-binding entrypoint
// (index.ts) call searchClawHubSkills so the agent-side search_skill
// tool and /v1/clawhub/search return identical data.

export const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

export interface ClawHubPackage {
  name: string;
  displayName: string;
  summary: string;
  family: string;
  latestVersion: string;
  ownerHandle: string;
  /** ClawHub-side flags surfaced for supply-chain decisions. Enforcement
   *  (verified-tier-only install) lands with the install_skill tool (SDS
   *  agent-self-install §2.4); search only reports the facts. */
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
