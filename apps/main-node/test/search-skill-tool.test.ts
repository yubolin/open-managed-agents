import { describe, it, expect } from "vitest";
import { buildTools } from "@open-managed-agents/agent/harness/tools";

// F2: search_skill tool — read-only ClawHub registry search.
// Mirrors the SDS agent-self-install §2.1 contract:
//   - registered only when a platform skillRpc channel exists (CF service
//     binding). Node self-host has no binding → tool absent, never a
//     silent fake (§2.7 explicit gating).
//   - results pass through verbatim from the platform; empty result set
//     returns [] — the tool must never fabricate "reference skills"
//     (appendix B layer 2).
//   - RPC failure returns an error string, not fake results.

const mockAgentConfig = {
  name: "test-agent",
  model: "claude-sonnet-5",
  instructions: "",
  tools: [] as unknown[],
  mcp_servers: [] as unknown[],
};

function makeRpc(results: Array<Record<string, unknown>> = []) {
  return {
    skillSearch: async (_opts: { tenantId: string; q?: string }) => ({
      status: 200 as const,
      results,
    }),
  };
}

describe("search_skill tool (F2)", () => {
  it("registers search_skill when skillRpc is provided (CF path)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {
      skillRpc: makeRpc(),
    });
    expect(tools["search_skill"]).toBeDefined();
  });

  it("does NOT register search_skill when skillRpc is absent (Node path, §2.7 no silent fake)", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {});
    expect(tools["search_skill"]).toBeUndefined();
  });

  it("passes results through verbatim with tenantId + q", async () => {
    const clawhubItem = {
      slug: "deployment-kit",
      name: "Deployment Kit",
      description: "Ops deployment runbook skill",
      version: "1.0.3",
      owner: "oma",
      verification_tier: "verified",
    };
    let seenOpts: { tenantId: string; q?: string } | null = null;
    const tools = await buildTools(mockAgentConfig as never, null as never, {
      tenantId: "t-test",
      skillRpc: {
        skillSearch: async (opts: { tenantId: string; q?: string }) => {
          seenOpts = opts;
          return { status: 200 as const, results: [clawhubItem] };
        },
      },
    });

    const result = (await (tools["search_skill"] as { execute: (args: unknown) => Promise<unknown> }).execute({
      q: "deployment",
    })) as { results: Array<Record<string, unknown>> };

    expect(seenOpts).toEqual({ tenantId: "t-test", q: "deployment" });
    expect(result.results).toEqual([clawhubItem]);
  });

  it("returns empty results array — never fabricates reference skills", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {
      skillRpc: makeRpc([]),
    });

    const result = (await (tools["search_skill"] as { execute: (args: unknown) => Promise<unknown> }).execute({
      q: "nonexistent-xyz",
    })) as { results: unknown[] };

    expect(result.results).toEqual([]);
  });

  it("surfaces RPC failure as an error string, not fake results", async () => {
    const tools = await buildTools(mockAgentConfig as never, null as never, {
      skillRpc: {
        skillSearch: async () => ({ status: 502 as const, error: "ClawHub search failed: 502" }),
      },
    });

    const result = await (tools["search_skill"] as { execute: (args: unknown) => Promise<unknown> }).execute({
      q: "anything",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("ClawHub search failed");
  });

  it("tenantId falls back to empty string when session context is unavailable", async () => {
    let seenTenant: string | undefined;
    const tools = await buildTools(mockAgentConfig as never, null as never, {
      skillRpc: {
        skillSearch: async (opts: { tenantId: string; q?: string }) => {
          seenTenant = opts.tenantId;
          return { status: 200 as const, results: [] };
        },
      },
    });

    await (tools["search_skill"] as { execute: (args: unknown) => Promise<unknown> }).execute({ q: "x" });
    expect(seenTenant).toBe("");
  });
});
