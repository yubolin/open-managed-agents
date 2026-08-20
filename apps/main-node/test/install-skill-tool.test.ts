import { describe, it, expect } from "vitest";
import { buildTools, getToolPermission } from "@open-managed-agents/agent/harness/tools";

// F3: install_skill tool — mutating, default always_ask (SDS §2.1).
//   - registered only when the platform skillRpc channel exists (CF);
//     Node self-host gets no tool, never a silent fake (§2.7)
//   - schema enforces explicit version pin; "latest" rejected (F1/§2.3)
//   - permission tier defaults to always_ask so unconfigured agents still
//     require user confirmation (Console pending-call flow)

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
    skillInstall: async (_o: { tenantId: string; slug: string; version: string }) => ({
      status: 201 as const,
      skill: { id: "skill_x", hash: "a".repeat(64) },
    }),
  };
}

function toolSchema(tools: Record<string, unknown>, name: string) {
  const t = tools[name] as { parameters?: { safeParse: (i: unknown) => { success: boolean } }; inputSchema?: { safeParse: (i: unknown) => { success: boolean } } };
  return t.parameters ?? t.inputSchema;
}

describe("install_skill tool (F3)", () => {
  it("registers install_skill when skillRpc is provided (CF path)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    expect(tools["install_skill"]).toBeDefined();
  });

  it("does NOT register install_skill when skillRpc is absent (Node path, §2.7)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {});
    expect(tools["install_skill"]).toBeUndefined();
  });

  it("strips execute — default permission tier is always_ask (pending-call flow)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    expect((tools["install_skill"] as { execute?: unknown }).execute).toBeUndefined();
  });

  it("schema rejects missing version and 'latest'; accepts explicit pin", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, { skillRpc: makeRpc() });
    const schema = toolSchema(tools, "install_skill");
    expect(schema, "tool schema must be exposed").toBeTruthy();
    expect(schema!.safeParse({ slug: "deployment-kit" }).success).toBe(false);
    expect(schema!.safeParse({ slug: "deployment-kit", version: "latest" }).success).toBe(false);
    expect(schema!.safeParse({ slug: "deployment-kit", version: "1.0.3" }).success).toBe(true);
  });

  it("getToolPermission: install_skill defaults to always_ask, search_skill stays always_allow", () => {
    expect(getToolPermission(mockAgentConfig as never, "install_skill")).toBe("always_ask");
    expect(getToolPermission(mockAgentConfig as never, "attach_skill")).toBe("always_ask");
    expect(getToolPermission(mockAgentConfig as never, "detach_skill")).toBe("always_ask");
    expect(getToolPermission(mockAgentConfig as never, "uninstall_skill")).toBe("always_ask");
    expect(getToolPermission(mockAgentConfig as never, "search_skill")).toBe("always_allow");
    expect(getToolPermission(mockAgentConfig as never, "bash")).toBe("always_allow");
  });

  it("explicit per-tool config overrides the always_ask default", () => {
    const cfg = {
      ...mockAgentConfig,
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [{ name: "install_skill", enabled: true, permission_policy: { type: "always_allow" } }],
        },
      ],
    };
    expect(getToolPermission(cfg as never, "install_skill")).toBe("always_allow");
  });
});
