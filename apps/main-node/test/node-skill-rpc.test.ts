import { describe, it, expect } from "vitest";
import { createNodeSkillRpc } from "../src/lib/node-skill-rpc.js";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { mintSkillConfirmation } from "../../main/src/lib/skill-confirmation.js";

function makeMockStores() {
  const kv = new InMemoryKvStore();
  const blobPuts = new Map<string, unknown>();
  const filesBlob = {
    head: async () => null,
    get: async () => null,
    put: async (k: string, v: unknown) => {
      blobPuts.set(k, v);
      return null;
    },
    delete: async () => {},
  };
  const agentsMap = new Map<string, { id: string; version: number; skills: unknown[] }>();
  agentsMap.set("agent-1", { id: "agent-1", version: 1, skills: [] });

  const agents = {
    get: async (o: { tenantId: string; agentId: string }) => agentsMap.get(o.agentId) ?? null,
    update: async (o: { tenantId: string; agentId: string; input: { skills?: unknown[] }; expectedVersion?: number }) => {
      const existing = agentsMap.get(o.agentId);
      if (!existing) throw new Error("not found");
      const next = {
        ...existing,
        skills: o.input.skills ?? existing.skills,
        version: existing.version + 1,
      };
      agentsMap.set(o.agentId, next);
      return next;
    },
  };

  return { kv, filesBlob, agents: agents as never, blobPuts, agentsMap };
}

describe("createNodeSkillRpc (Node runtime Skill control plane)", () => {
  it("skillSearch returns results without crashing", async () => {
    const s = makeMockStores();
    const rpc = createNodeSkillRpc({
      agents: s.agents,
      filesBlob: s.filesBlob,
      kv: s.kv,
    });
    const res = await rpc.skillSearch({ tenantId: "default", q: "deploy" });
    expect(res.status).toBe(200);
    expect("results" in res).toBe(true);
  });

  it("skillInstall refuses execution without confirmation token", async () => {
    const s = makeMockStores();
    const rpc = createNodeSkillRpc({
      agents: s.agents,
      filesBlob: s.filesBlob,
      kv: s.kv,
    });
    const res = await rpc.skillInstall({
      tenantId: "t-test",
      slug: "test-slug",
      version: "1.0.0",
    });
    expect(res.status).toBe(403);
  });

  it("skillAttach refuses execution without confirmation token, but succeeds when confirmed", async () => {
    const s = makeMockStores();
    const rpc = createNodeSkillRpc({
      agents: s.agents,
      filesBlob: s.filesBlob,
      kv: s.kv,
    });

    // 1. Missing token → 403
    const denied = await rpc.skillAttach({
      tenantId: "t-test",
      agentId: "agent-1",
      skillId: "skill_1",
      version: "1.0.0",
      hash: "a".repeat(64),
    });
    expect(denied.status).toBe(403);

    // 2. Pre-seed skill version in KV for hash validation
    await s.kv.put(
      "t:t-test:skillver:skill_1:1.0.0",
      JSON.stringify({ version: "1.0.0", hash: "a".repeat(64), files: [] }),
    );

    // 3. Mint valid bound token
    const binding = {
      sessionId: "sess-1",
      toolUseId: "call-1",
      toolName: "attach_skill",
      canonicalInput: { agent_id: "agent-1", skill_id: "skill_1" },
    };
    const mint = await mintSkillConfirmation({
      kv: s.kv,
      tenantId: "t-test",
      purpose: "attach",
      binding,
    });

    // 4. Attach with token + binding → 200
    const allowed = await rpc.skillAttach({
      tenantId: "t-test",
      agentId: "agent-1",
      skillId: "skill_1",
      version: "1.0.0",
      hash: "a".repeat(64),
      confirmationToken: mint.token,
      binding,
    });
    expect(allowed.status).toBe(200);
    if ("attached" in allowed) {
      expect(allowed.attached.new_session_required).toBe(true);
      expect(allowed.attached.skill_id).toBe("skill_1");
    }
  });
});
