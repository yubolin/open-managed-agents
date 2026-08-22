import { describe, it, expect } from "vitest";
import {
  projectToolResultForModel,
  MAX_INLINE_RESULT_CHARS,
} from "../src/harness/large-tool-result-guard";
import { eventsToMessages } from "../src/runtime/history";
import type { SessionEvent, AgentToolUseEvent, AgentMcpToolResultEvent } from "@open-managed-agents/shared";

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
});
