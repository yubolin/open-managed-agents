import { describe, it, expect } from "vitest";
import { buildTools, getToolPermission } from "@open-managed-agents/agent/harness/tools";

// F4: attach_skill tool — mutating, default always_ask (SDS §2.1).
//   - registered only when the platform skillRpc channel exists (CF);
//     Node self-host gets no tool, never a silent fake (§2.7)
//   - schema: version explicit (never "latest"), hash must be sha256 hex
//     from install_skill (SDS §2.4 hash re-check inputs)
//   - execute stripped under default always_ask → Console pending-call flow
//   - result carries new_session_required: true — sessions freeze the
//     snapshot, attach NEVER hot-reloads (SDS §2.6)

const mockAgentConfig = {
  name: "test-agent",
  model: "claude-sonnet-5",
  instructions: "",
  tools: [] as unknown[],
  mcp_servers: [] as unknown[],
};

function makeRpc() {
  return {
    skillSearch: async () => ({ status: 200 as const, results: [] }),
    skillInstall: async () => ({ status: 201 as const, skill: { id: "skill_x" } }),
    skillAttach: async (_o: {
      tenantId: string;
      agentId: string;
      skillId: string;
      version: string;
      hash: string;
    }) => ({
      status: 200 as const,
      attached: {
        new_session_required: true as const,
        skill_id: "skill_x",
        version: "v1",
        agent_version: 4,
      },
    }),
  };
}

function toolSchema(tools: Record<string, unknown>, name: string) {
  const t = tools[name] as { parameters?: { safeParse: (i: unknown) => { success: boolean } }; inputSchema?: { safeParse: (i: unknown) => { success: boolean } } };
  return t.parameters ?? t.inputSchema;
}

describe("attach_skill tool (F4)", () => {
  it("registers attach_skill when skillRpc is provided (CF path)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    expect(tools["attach_skill"]).toBeDefined();
  });

  it("does NOT register attach_skill when skillRpc is absent (Node path, §2.7)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {});
    expect(tools["attach_skill"]).toBeUndefined();
  });

  it("strips execute — default permission tier is always_ask (pending-call flow)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    expect((tools["attach_skill"] as { execute?: unknown }).execute).toBeUndefined();
  });

  it("schema rejects missing fields, 'latest' version, non-sha256 hash; accepts valid input", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    const schema = toolSchema(tools, "attach_skill");
    expect(schema, "tool schema must be exposed").toBeTruthy();
    const good = {
      agent_id: "agent_1",
      skill_id: "skill_x",
      version: "v1",
      hash: "a".repeat(64),
    };
    expect(schema!.safeParse(good).success).toBe(true);
    expect(schema!.safeParse({ ...good, agent_id: "" }).success).toBe(false);
    expect(schema!.safeParse({ ...good, version: "" }).success).toBe(false);
    expect(schema!.safeParse({ ...good, version: "latest" }).success).toBe(false);
    expect(schema!.safeParse({ ...good, hash: "not-hex" }).success).toBe(false);
    expect(schema!.safeParse({ ...good, hash: "a".repeat(63) }).success).toBe(false);
  });

  it("getToolPermission: attach_skill defaults to always_ask", () => {
    expect(getToolPermission(mockAgentConfig as never, "attach_skill")).toBe("always_ask");
  });

  it("explicit per-tool config overrides the always_ask default", () => {
    const cfg = {
      ...mockAgentConfig,
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [{ name: "attach_skill", enabled: true, permission_policy: { type: "always_allow" } }],
        },
      ],
    };
    expect(getToolPermission(cfg as never, "attach_skill")).toBe("always_allow");
  });
});
