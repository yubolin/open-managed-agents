// attach_skill backend (SDS agent-self-install §2.4-2.6, slice F4).
// Pure lib with injected stores — SkillRpc.skillAttach (index.ts) wraps it
// so the agent-side tool and any future HTTP route share one policy.
//
// Contract:
//   - hash re-check: the caller-passed sha256 must equal the hash pinned in
//     the KV skillver manifest at install time → mismatch is 409 (§2.4)
//   - optimistic concurrency: the agent row's `version` IS the etag. We do
//     read-modify-write via agents.update({expectedVersion}) and retry ONCE
//     on AgentVersionMismatchError; a second conflict surfaces as
//     AttachConflictError carrying the latest version (§2.5)
//   - new_session_required: always true in the success payload — sessions
//     freeze the agent snapshot at creation, so attach NEVER hot-reloads a
//     running session (§2.6 hard constraint)

import { AgentVersionMismatchError } from "@open-managed-agents/agents-store";
import { kvKey } from "../kv-helpers";

export class AttachValidationError extends Error {}
export class SkillNotFoundError extends Error {}
/** Hash mismatch vs the pinned skillver manifest — 409 (SDS §2.4). */
export class HashMismatchError extends Error {}
export class AgentNotFoundError extends Error {}
/** Lost the update race twice — 409, caller may re-read and retry (§2.5). */
export class AttachConflictError extends Error {
  constructor(
    message: string,
    public readonly latestAgentVersion: number,
  ) {
    super(message);
  }
}

export interface AttachedSkill {
  new_session_required: true;
  skill_id: string;
  version: string;
  /** Agent row version after the write — callers use it as the next etag. */
  agent_version: number;
}

/** Minimal structural deps (F3 pattern): tests inject fakes, prod passes
 *  the tenant-scoped services from getCfServicesForTenant. */
interface SkillEntry {
  skill_id: string;
  type: string;
  version?: string;
}

interface AgentReader {
  get(o: { tenantId: string; agentId: string }): Promise<{ version: number; skills?: SkillEntry[] } | null>;
}

interface AgentWriter {
  update(o: {
    tenantId: string;
    agentId: string;
    expectedVersion?: number;
    input: { skills?: SkillEntry[] };
  }): Promise<{ version: number; skills?: SkillEntry[] }>;
}

function attachInputError(
  agentId: string,
  skillId: string,
  version: string,
  hash: string,
): string | null {
  if (!agentId) return "agent_id is required";
  if (!skillId) return "skill_id is required";
  if (!version) return "version is required (latest is not allowed; pass an explicit version)";
  if (version === "latest") return "version 'latest' is forbidden; pass an explicit version pin";
  if (!/^[0-9a-f]{64}$/.test(hash)) return "hash must be the sha256 hex returned by install_skill";
  return null;
}

export async function attachSkillToAgent(args: {
  tenantId: string;
  agentId: string;
  skillId: string;
  version: string;
  hash: string;
  kv: { get(key: string): Promise<string | null> };
  agents: AgentReader & AgentWriter;
}): Promise<AttachedSkill> {
  const inputError = attachInputError(args.agentId, args.skillId, args.version, args.hash);
  if (inputError) throw new AttachValidationError(inputError);

  // 1. Hash re-check against the pinned skillver manifest (fail closed —
  //    a missing or hash-less manifest means the skill/version pair was
  //    never installed through the F3 path).
  const verRaw = await args.kv.get(kvKey(args.tenantId, "skillver", args.skillId, args.version));
  if (!verRaw) {
    throw new SkillNotFoundError(
      `skill ${args.skillId} version ${args.version} not found in tenant library`,
    );
  }
  const ver = JSON.parse(verRaw) as { hash?: string };
  if (!ver.hash) {
    throw new SkillNotFoundError(
      `skill ${args.skillId} version ${args.version} manifest has no pinned hash (installed pre-F3?); reinstall it`,
    );
  }
  if (ver.hash !== args.hash) {
    throw new HashMismatchError(
      `hash mismatch: install_skill pinned ${ver.hash} but attach_skill received ${args.hash}`,
    );
  }

  // 2. Read-modify-write with retry-once on version conflict (§2.5).
  for (let attempt = 0; ; attempt++) {
    const agent = await args.agents.get({ tenantId: args.tenantId, agentId: args.agentId });
    if (!agent) throw new AgentNotFoundError(`agent ${args.agentId} not found`);

    const existing = agent.skills ?? [];
    const entry: SkillEntry = { skill_id: args.skillId, type: "custom", version: args.version };

    // Idempotent: identical binding already present → no write, no version
    // bump. new_session_required stays true — the CURRENT session still
    // runs on its frozen snapshot either way (§2.6).
    if (existing.some((s) => s.skill_id === args.skillId && s.version === args.version)) {
      return {
        new_session_required: true,
        skill_id: args.skillId,
        version: args.version,
        agent_version: agent.version,
      };
    }

    // Upsert: drop any prior entry for this skill_id (version upgrade
    // path), append the new one, keep everyone else's bindings.
    const nextSkills = [
      ...existing.filter((s) => s.skill_id !== args.skillId),
      entry,
    ];

    try {
      const row = await args.agents.update({
        tenantId: args.tenantId,
        agentId: args.agentId,
        expectedVersion: agent.version,
        input: { skills: nextSkills },
      });
      return {
        new_session_required: true,
        skill_id: args.skillId,
        version: args.version,
        agent_version: row.version,
      };
    } catch (err) {
      if (err instanceof AgentVersionMismatchError) {
        if (attempt >= 1) {
          throw new AttachConflictError(
            `agent ${args.agentId} updated concurrently; latest version is ${err.actual}`,
            err.actual,
          );
        }
        continue; // retry-once with a fresh read
      }
      throw err;
    }
  }
}
