// F4: attachSkillToAgent lib — hash re-check against the skillver manifest
// (SDS §2.4: mismatch → 409), optimistic concurrency via the agent row's
// `version` (SDS §2.5: expectedVersion + retry-once, second conflict → 409),
// and `new_session_required` semantics (SDS §2.6: sessions freeze the
// snapshot at creation — attach NEVER hot-reloads).
//
// Follows the F3 pattern: pure lib with injected stores so the HTTP/SkillRpc
// wrapper stays thin and tests need no workerd bindings.

import { describe, it, expect } from "vitest";
import { AgentVersionMismatchError } from "@open-managed-agents/agents-store";
import {
  attachSkillToAgent,
  AttachValidationError,
  SkillNotFoundError,
  HashMismatchError,
  AgentNotFoundError,
  AttachConflictError,
} from "../src/lib/skill-attach";

interface SkillEntry {
  skill_id: string;
  type: string;
  version?: string;
}

interface AgentRow {
  version: number;
  skills?: SkillEntry[];
}

function makeKv(skillver: Record<string, string> = {}) {
  return { get: async (k: string) => skillver[k] ?? null };
}

function makeAgents(
  rows: Record<string, AgentRow>,
): {
  store: {
    get: (o: { tenantId: string; agentId: string }) => Promise<AgentRow | null>;
    update: (o: {
      tenantId: string;
      agentId: string;
      expectedVersion?: number;
      input: { skills?: SkillEntry[] };
    }) => Promise<AgentRow>;
  };
  updates: Array<{ expectedVersion?: number; skills?: SkillEntry[] }>;
} {
  const updates: Array<{ expectedVersion?: number; skills?: SkillEntry[] }> = [];
  const store = {
    get: async (o: { tenantId: string; agentId: string }) => rows[o.agentId] ?? null,
    update: async (o: {
      tenantId: string;
      agentId: string;
      expectedVersion?: number;
      input: { skills?: SkillEntry[] };
    }) => {
      updates.push({ expectedVersion: o.expectedVersion, skills: o.input.skills });
      const row = rows[o.agentId];
      if (!row) throw new Error("agent vanished");
      if (o.expectedVersion !== undefined && o.expectedVersion !== row.version) {
        throw new AgentVersionMismatchError(o.expectedVersion, row.version);
      }
      const next: AgentRow = { ...row, version: row.version + 1, skills: o.input.skills };
      rows[o.agentId] = next;
      return next;
    },
  };
  return { store, updates };
}

const GOOD_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function kvWithSkill(hash = GOOD_HASH): Record<string, string> {
  return {
    "t:t-test:skillver:skill_x:v1": JSON.stringify({
      version: "v1",
      hash,
      files: [{ filename: "SKILL.md", size_bytes: 10, encoding: "utf8" }],
    }),
  };
}

const BASE = {
  tenantId: "t-test",
  agentId: "agent_1",
  skillId: "skill_x",
  version: "v1",
  hash: GOOD_HASH,
};

describe("attachSkillToAgent input validation (SDS §2.3)", () => {
  it("rejects missing agent_id / skill_id / version / hash", async () => {
    const kv = makeKv(kvWithSkill());
    const { store } = makeAgents({ agent_1: { version: 3, skills: [] } });
    await expect(
      attachSkillToAgent({ ...BASE, agentId: "", kv, agents: store }),
    ).rejects.toBeInstanceOf(AttachValidationError);
    await expect(
      attachSkillToAgent({ ...BASE, skillId: "", kv, agents: store }),
    ).rejects.toBeInstanceOf(AttachValidationError);
    await expect(
      attachSkillToAgent({ ...BASE, version: "", kv, agents: store }),
    ).rejects.toBeInstanceOf(AttachValidationError);
    await expect(
      attachSkillToAgent({ ...BASE, hash: "", kv, agents: store }),
    ).rejects.toBeInstanceOf(AttachValidationError);
  });

  it("rejects version 'latest' — explicit pin required", async () => {
    const kv = makeKv(kvWithSkill());
    const { store } = makeAgents({ agent_1: { version: 3, skills: [] } });
    await expect(
      attachSkillToAgent({ ...BASE, version: "latest", kv, agents: store }),
    ).rejects.toBeInstanceOf(AttachValidationError);
  });
});

describe("attachSkillToAgent hash re-check (SDS §2.4)", () => {
  it("hash mismatch → HashMismatchError (maps 409)", async () => {
    const kv = makeKv(kvWithSkill(OTHER_HASH));
    const { store, updates } = makeAgents({ agent_1: { version: 3, skills: [] } });
    await expect(
      attachSkillToAgent({ ...BASE, kv, agents: store }),
    ).rejects.toBeInstanceOf(HashMismatchError);
    expect(updates.length).toBe(0); // no agent write on hash failure
  });

  it("missing skillver manifest → SkillNotFoundError (maps 404)", async () => {
    const kv = makeKv({}); // nothing installed
    const { store } = makeAgents({ agent_1: { version: 3, skills: [] } });
    await expect(
      attachSkillToAgent({ ...BASE, kv, agents: store }),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("manifest without hash field → SkillNotFoundError (corrupt manifest, fail closed)", async () => {
    const kv = makeKv({ "t:t-test:skillver:skill_x:v1": JSON.stringify({ version: "v1" }) });
    const { store } = makeAgents({ agent_1: { version: 3, skills: [] } });
    await expect(
      attachSkillToAgent({ ...BASE, kv, agents: store }),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });
});

describe("attachSkillToAgent optimistic concurrency (SDS §2.5)", () => {
  it("unknown agent → AgentNotFoundError (maps 404)", async () => {
    const kv = makeKv(kvWithSkill());
    const { store } = makeAgents({});
    await expect(attachSkillToAgent({ ...BASE, kv, agents: store })).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it("happy path: appends {skill_id, type:'custom', version} with expectedVersion, returns new_session_required", async () => {
    const kv = makeKv(kvWithSkill());
    const { store, updates } = makeAgents({ agent_1: { version: 3, skills: [] } });
    const res = await attachSkillToAgent({ ...BASE, kv, agents: store });
    expect(res).toEqual({
      new_session_required: true,
      skill_id: "skill_x",
      version: "v1",
      agent_version: 4,
    });
    expect(updates.length).toBe(1);
    expect(updates[0].expectedVersion).toBe(3);
    expect(updates[0].skills).toEqual([{ skill_id: "skill_x", type: "custom", version: "v1" }]);
  });

  it("preserves existing skills (append, not replace-all)", async () => {
    const kv = makeKv(kvWithSkill());
    const { store, updates } = makeAgents({
      agent_1: { version: 1, skills: [{ skill_id: "skill_builtin", type: "builtin", version: "9" }] },
    });
    await attachSkillToAgent({ ...BASE, kv, agents: store });
    expect(updates[0].skills).toEqual([
      { skill_id: "skill_builtin", type: "builtin", version: "9" },
      { skill_id: "skill_x", type: "custom", version: "v1" },
    ]);
  });

  it("already attached same version → idempotent success, NO agent write", async () => {
    const kv = makeKv(kvWithSkill());
    const { store, updates } = makeAgents({
      agent_1: { version: 5, skills: [{ skill_id: "skill_x", type: "custom", version: "v1" }] },
    });
    const res = await attachSkillToAgent({ ...BASE, kv, agents: store });
    expect(res.new_session_required).toBe(true);
    expect(res.agent_version).toBe(5); // unchanged
    expect(updates.length).toBe(0);
  });

  it("already attached different version → upsert replaces the entry", async () => {
    const kv = makeKv(kvWithSkill());
    const { store, updates } = makeAgents({
      agent_1: { version: 5, skills: [{ skill_id: "skill_x", type: "custom", version: "v0" }] },
    });
    await attachSkillToAgent({ ...BASE, kv, agents: store });
    expect(updates[0].skills).toEqual([{ skill_id: "skill_x", type: "custom", version: "v1" }]);
  });

  it("first update conflicts → retry-once with fresh version succeeds", async () => {
    const kv = makeKv(kvWithSkill());
    // Concurrency simulation: agent row bumps v3→v4 between the read and the
    // first update, so attempt 1 sees stale v3 and mismatches; attempt 2
    // re-reads v4 and wins.
    const rows: Record<string, AgentRow> = { agent_1: { version: 3, skills: [] } };
    const updates: Array<{ expectedVersion?: number }> = [];
    let firstRead = true;
    const store = {
      get: async () => {
        if (firstRead) {
          firstRead = false;
          return { version: 3, skills: [] as SkillEntry[] };
        }
        return rows.agent_1;
      },
      update: async (o: { expectedVersion?: number; input: { skills?: SkillEntry[] } }) => {
        updates.push({ expectedVersion: o.expectedVersion });
        const row = rows.agent_1;
        if (o.expectedVersion !== row.version) {
          // concurrent writer already bumped it
          throw new AgentVersionMismatchError(o.expectedVersion!, row.version);
        }
        rows.agent_1 = { ...row, version: row.version + 1, skills: o.input.skills };
        return rows.agent_1;
      },
    };
    // simulate the concurrent bump: before first update, row is v4
    rows.agent_1 = { version: 4, skills: [] };
    const res = await attachSkillToAgent({
      ...BASE,
      kv,
      agents: store as never,
    });
    expect(updates).toEqual([{ expectedVersion: 3 }, { expectedVersion: 4 }]);
    expect(res.agent_version).toBe(5);
  });

  it("both attempts conflict → AttachConflictError carrying latest agent version (maps 409)", async () => {
    const kv = makeKv(kvWithSkill());
    // Row keeps moving: always at v9 no matter what the caller read.
    const rows: Record<string, AgentRow> = { agent_1: { version: 9, skills: [] } };
    const store = {
      get: async () => ({ version: 9 - 1, skills: [] as SkillEntry[] }), // always stale by one
      update: async (o: { expectedVersion?: number }) => {
        throw new AgentVersionMismatchError(o.expectedVersion ?? 0, rows.agent_1.version);
      },
    };
    const err = await attachSkillToAgent({ ...BASE, kv, agents: store as never }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AttachConflictError);
    expect((err as AttachConflictError).latestAgentVersion).toBe(9);
  });
});
