import { describe, it, expect, vi } from "vitest";
import {
  projectToolResultForModel,
  MAX_INLINE_RESULT_CHARS,
  sha256Hex,
  materializeToolResultToWorkspace,
  rebuildExternalizedToolResultsFromEvents,
} from "../src/harness/large-tool-result-guard";
import { eventsToMessages } from "../src/runtime/history";
import { buildTools } from "../src/harness/tools";
import type { SandboxExecutor } from "../src/harness/interface";
import type { SessionEvent, AgentToolUseEvent, AgentMcpToolResultEvent } from "@open-managed-agents/shared";

vi.mock("@ai-sdk/mcp", () => ({ experimental_createMCPClient: vi.fn() }));

describe("large-tool-result-guard", () => {
  it("leaves small tool results (<12KB) unchanged", () => {
    const smallContent = "This is a short tool result output.";
    const res = projectToolResultForModel(smallContent, "call_123", "read");
    expect(res.isExternalized).toBe(false);
    expect(res.output).toBe(smallContent);
  });

  it("intercepts large tool results (e.g. 369KB, 148KB) and projects bounded head/tail preview", () => {
    const headText = "--- BEGIN FEISHU KB DOCUMENT ---\nTitle: 问学 租户级记忆报错排查手册\n";
    const middleText = "x".repeat(369_000);
    const tailText = "\n--- END FEISHU KB DOCUMENT --- Status: Resolved";
    const largeContent = headText + middleText + tailText; // ~369KB

    const res = projectToolResultForModel(largeContent, "call_feishu_369k", "docx_v1_document_rawContent");
    expect(res.isExternalized).toBe(true);

    const parsed = JSON.parse(res.output);
    expect(parsed.status).toBe("externalized");
    expect(parsed.tool_call_id).toBe("call_feishu_369k");
    expect(parsed.tool_name).toBe("docx_v1_document_rawContent");
    expect(parsed.byte_length).toBeGreaterThan(369_000);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.workspace_path).toBe("/workspace/.mcp/call_feishu_369k.txt");
    expect(parsed.instruction).toContain("read");

    // Check preview contains both head and tail
    expect(parsed.preview).toContain("问学 租户级记忆报错排查手册");
    expect(parsed.preview).toContain("Status: Resolved");
    expect(parsed.preview.length).toBeLessThan(4000);
  });

  it("integrates with eventsToMessages to project bounded ModelMessage without mutating event log", () => {
    const largeDoc = "Feishu Doc Content: " + "A".repeat(150_000) + " Conclusion: All green";
    const toolCallId = "call_mcp_test_999";

    const events: SessionEvent[] = [
      {
        id: "evt_1",
        session_id: "sess_1",
        type: "user.message",
        created_at: 100,
        content: [{ type: "text", text: "Read doc" }],
      },
      {
        id: toolCallId,
        session_id: "sess_1",
        type: "agent.mcp_tool_use",
        created_at: 101,
        mcp_server_name: "feishu-kb",
        name: "docx_v1_document_rawContent",
        input: { document_id: "doc_123" },
      } as AgentToolUseEvent,
      {
        id: "evt_3",
        session_id: "sess_1",
        type: "agent.mcp_tool_result",
        created_at: 102,
        mcp_tool_use_id: toolCallId,
        content: largeDoc,
      } as AgentMcpToolResultEvent,
    ];

    const messages = eventsToMessages(events);

    // Assert tool message is bounded
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBeDefined();

    const toolPart = (toolMsg?.content as any[])[0];
    expect(toolPart.type).toBe("tool-result");
    expect(toolPart.toolCallId).toBe(toolCallId);
    expect(toolPart.output.type).toBe("text");

    const projectedJson = JSON.parse(toolPart.output.value);
    expect(projectedJson.status).toBe("externalized");
    expect(projectedJson.preview).toContain("Conclusion: All green");

    // Invariant I1: Raw event in events array MUST NOT be mutated!
    const rawResultEvent = events[2] as AgentMcpToolResultEvent;
    expect(rawResultEvent.content).toBe(largeDoc);
    expect(rawResultEvent.content.length).toBe(largeDoc.length);
  });

  describe("sha256Hex", () => {
    it("hashes UTF-8 correctly", () => {
      // "你好世界" sha256 is beca6335b20ff57ccc47403ef4d9e0b8fccb4442b3151c2e7d50050673d43172
      expect(sha256Hex("你好世界")).toBe("beca6335b20ff57ccc47403ef4d9e0b8fccb4442b3151c2e7d50050673d43172");
    });
  });

  describe("materializeToolResultToWorkspace", () => {
    it("throws if writeFile fails", async () => {
      const sandbox = {
        writeFile: async () => { throw new Error("Disk full"); }
      } as any;
      const largeContent = "x".repeat(MAX_INLINE_RESULT_CHARS + 1);
      await expect(materializeToolResultToWorkspace(sandbox, "call_1", largeContent)).rejects.toThrow("Disk full");
    });
  });

  describe("rebuildExternalizedToolResultsFromEvents (sandbox restart recovery)", () => {
    it("rebuilds all externalized files in the workspace on sandbox restart (empty sandbox)", async () => {
      const writtenFiles: Record<string, string> = {};
      const sandbox = {
        fileExists: async () => false,
        writeFile: async (path: string, content: string) => {
          writtenFiles[path] = content;
        },
      } as any;

      const largeContent1 = "Doc 1 ".repeat(3000); // ~18KB
      const largeContent2 = "Doc 2 ".repeat(4000); // ~24KB
      const smallContent = "Small output";

      const events: SessionEvent[] = [
        {
          id: "e1",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_large_1",
          content: largeContent1,
        } as any,
        {
          id: "e2",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_small",
          content: smallContent,
        } as any,
        {
          id: "e3",
          session_id: "s1",
          type: "agent.mcp_tool_result",
          mcp_tool_use_id: "call_large_2",
          content: largeContent2,
        } as any,
      ];

      const count = await rebuildExternalizedToolResultsFromEvents(sandbox, events);
      expect(count).toBe(2);
      expect(writtenFiles["/workspace/.mcp/call_large_1.txt"]).toBe(largeContent1);
      expect(writtenFiles["/workspace/.mcp/call_large_2.txt"]).toBe(largeContent2);
      expect(writtenFiles["/workspace/.mcp/call_small.txt"]).toBeUndefined();
    });

    it("(a) existing file is not rewritten", async () => {
      const writeFileSpy = vi.fn();
      const existingFiles = new Set(["/workspace/.mcp/call_already_exists.txt"]);
      const sandbox = {
        fileExists: async (path: string) => existingFiles.has(path),
        writeFile: writeFileSpy,
      } as any;

      const largeContent = "Existing Doc ".repeat(3000);
      const events: SessionEvent[] = [
        {
          id: "e1",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_already_exists",
          content: largeContent,
        } as any,
      ];

      const count = await rebuildExternalizedToolResultsFromEvents(sandbox, events);
      expect(count).toBe(0);
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("(b) missing file is written", async () => {
      const writeFileSpy = vi.fn();
      const sandbox = {
        fileExists: async () => false,
        writeFile: writeFileSpy,
      } as any;

      const largeContent = "Missing Doc ".repeat(3000);
      const events: SessionEvent[] = [
        {
          id: "e1",
          session_id: "s1",
          type: "agent.mcp_tool_result",
          mcp_tool_use_id: "call_missing_1",
          content: largeContent,
        } as any,
      ];

      const count = await rebuildExternalizedToolResultsFromEvents(sandbox, events);
      expect(count).toBe(1);
      expect(writeFileSpy).toHaveBeenCalledWith("/workspace/.mcp/call_missing_1.txt", largeContent);
    });

    it("(c) mixed history writes only missing entries", async () => {
      const writtenFiles: Record<string, string> = {};
      const existingFiles = new Set(["/workspace/.mcp/call_1.txt"]);
      const sandbox = {
        fileExists: async (path: string) => existingFiles.has(path),
        writeFile: async (path: string, content: string) => {
          writtenFiles[path] = content;
        },
      } as any;

      const largeContent1 = "Doc 1 ".repeat(3000);
      const largeContent2 = "Doc 2 ".repeat(3000);
      const events: SessionEvent[] = [
        {
          id: "e1",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_1", // exists
          content: largeContent1,
        } as any,
        {
          id: "e2",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_2", // missing
          content: largeContent2,
        } as any,
      ];

      const count = await rebuildExternalizedToolResultsFromEvents(sandbox, events);
      expect(count).toBe(1);
      expect(writtenFiles["/workspace/.mcp/call_1.txt"]).toBeUndefined();
      expect(writtenFiles["/workspace/.mcp/call_2.txt"]).toBe(largeContent2);
    });

    it("propagates write failures without hiding errors", async () => {
      const sandbox = {
        fileExists: async () => false,
        writeFile: async () => {
          throw new Error("Disk quota exceeded");
        },
      } as any;

      const largeContent = "Large Doc ".repeat(3000);
      const events: SessionEvent[] = [
        {
          id: "e1",
          session_id: "s1",
          type: "agent.tool_result",
          tool_use_id: "call_err",
          content: largeContent,
        } as any,
      ];

      await expect(rebuildExternalizedToolResultsFromEvents(sandbox, events)).rejects.toThrow("Disk quota exceeded");
    });
  });

  describe("tool execution durability barrier (MCP & safe wrappers)", () => {
    it("built-in tool safe wrapper materializes large results and surfaces explicit error on failure", async () => {
      const written: Record<string, string> = {};
      let shouldFail = false;
      const sandbox: SandboxExecutor = {
        exec: async () => "x".repeat(MAX_INLINE_RESULT_CHARS + 100),
        writeFile: async (path: string, content: string) => {
          if (shouldFail) throw new Error("Sandbox disk full");
          written[path] = content;
        },
        readFile: async () => "",
        fileExists: async () => false,
      };

      const tools = await buildTools({ name: "test", tools: [{ name: "bash", enabled: true }] } as any, sandbox, {
        ANTHROPIC_API_KEY: "test",
      });

      // 1. Successful materialization
      const resOk = await tools.bash.execute({ command: "echo test" }, { toolCallId: "call_bash_1" });
      expect(typeof resOk).toBe("string");
      expect(resOk.length).toBeGreaterThan(MAX_INLINE_RESULT_CHARS);
      expect(written["/workspace/.mcp/call_bash_1.txt"]).toBe(resOk);

      // 2. Materialization failure surfaces error and does not advertise path
      shouldFail = true;
      const resErr = await tools.bash.execute({ command: "echo test" }, { toolCallId: "call_bash_2" });
      expect(typeof resErr).toBe("string");
      expect(resErr).toContain("Error: Sandbox disk full");
    });

    it("buildTools MCP wrapper (production code path) materializes large results and rejects on writeFile failure", async () => {
      // ---- sandbox ----
      const written: Record<string, string> = {};
      let shouldFail = false;
      const sandbox: SandboxExecutor = {
        exec: async () => "",
        writeFile: async (path: string, content: string) => {
          if (shouldFail) throw new Error("MCP workspace write failed");
          written[path] = content;
        },
        readFile: async () => "",
        fileExists: async () => false,
      };

      // ---- fake MCP tool that returns a large result ----
      const largeText = "MCP Result ".repeat(2000); // ~22KB > MAX_INLINE_RESULT_CHARS
      const fakeMcpToolExecute = vi.fn(async () => largeText);
      const fakeRemoteTools = {
        fetch_doc: {
          description: "Fetch a doc",
          parameters: {},
          execute: fakeMcpToolExecute,
        },
      };

      // ---- wire up the mock so experimental_createMCPClient returns our fake client ----
      const { experimental_createMCPClient } = await import("@ai-sdk/mcp");
      (experimental_createMCPClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        tools: async () => fakeRemoteTools,
      });

      // ---- call buildTools with an mcp_servers config ----
      // mcpFetch bypasses the "missing mcpBinding / tenantId / sessionId" guard
      const tools = await buildTools(
        {
          name: "test-mcp",
          tools: [],
          mcp_servers: [{ name: "test-server", url: "http://localhost:1234/mcp" }],
        } as any,
        sandbox,
        {
          ANTHROPIC_API_KEY: "test",
          mcpFetch: () => globalThis.fetch,
        },
      );

      // The production wrapper registers the tool as mcp__<serverName>__<toolName>
      const wrappedTool = (tools as any)["mcp__test-server__fetch_doc"];
      expect(wrappedTool, "wrapped MCP tool should be registered by buildTools").toBeDefined();

      // 1. Successful materialization — production wrapper writes to sandbox
      const okResult = await wrappedTool.execute({}, { toolCallId: "call_mcp_1" });
      expect(okResult).toBe(largeText);
      expect(written["/workspace/.mcp/call_mcp_1.txt"]).toBe(largeText);

      // 2. writeFile failure — production wrapper must propagate the error (not swallow it)
      shouldFail = true;
      await expect(
        wrappedTool.execute({}, { toolCallId: "call_mcp_2" }),
      ).rejects.toThrow("MCP workspace write failed");
    });
  });
});
