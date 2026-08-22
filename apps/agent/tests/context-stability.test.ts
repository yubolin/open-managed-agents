import { describe, it, expect } from "vitest";
import {
  detectContextOverflowError,
  buildEmergencyPrunedContext,
} from "../src/harness/default-loop";
import {
  resolveContextWindowTokens,
  computeUsableInputTokens,
} from "../src/harness/context-window";
import {
  estimateFullContextTokens,
  estimateMessagesTokens,
} from "../src/harness/token-estimator";
import { eventsToMessages } from "../src/runtime/history";
import type { SessionEvent, AgentToolUseEvent, AgentMcpToolResultEvent } from "@open-managed-agents/shared";

describe("context-stability & large result governance (SDS v0.4 replay)", () => {
  describe("detectContextOverflowError", () => {
    it("detects MiniMax 400 (error 2013) context overflow", () => {
      const err = {
        statusCode: 400,
        message: "invalid params",
        responseBody: '{"base_resp":{"status_code":2013,"status_msg":"context window exceeds limit"}}',
      };
      const diag = detectContextOverflowError(err);
      expect(diag.isOverflow).toBe(true);
      expect(diag.statusCode).toBe(400);
      expect(diag.providerCode).toBe(2013);
    });

    it("detects Anthropic prompt too long error", () => {
      const err = new Error("400 prompt exceeds maximum context length of 200000 tokens");
      const diag = detectContextOverflowError(err);
      expect(diag.isOverflow).toBe(true);
      expect(diag.statusCode).toBe(400);
    });

    it("detects OpenAI context_length_exceeded error", () => {
      const err = new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens. (context_length_exceeded)");
      const diag = detectContextOverflowError(err);
      expect(diag.isOverflow).toBe(true);
    });

    it("returns false for standard non-overflow errors", () => {
      const err = new Error("500 Internal Server Error");
      const diag = detectContextOverflowError(err);
      expect(diag.isOverflow).toBe(false);
    });
  });

  describe("production incident scenario replay (369KB + 148KB + 112KB)", () => {
    it("governs 3 massive MCP tool results, preventing 228k token context explosion", () => {
      const doc369k = "Doc 1 Header\n" + "内容".repeat(92_000) + "\nDoc 1 Footer"; // ~369KB / 184k CJK chars
      const doc148k = "Doc 2 Header\n" + "详情".repeat(37_000) + "\nDoc 2 Footer"; // ~148KB / 74k CJK chars
      const doc112k = "Doc 3 Header\n" + "说明".repeat(28_000) + "\nDoc 3 Footer"; // ~112KB / 56k CJK chars

      const events: SessionEvent[] = [
        {
          id: "evt_user_1",
          session_id: "sess_prod_replay",
          type: "user.message",
          created_at: 100,
          content: [{ type: "text", text: "请查询问学租户级记忆报错排查手册及关联文档" }],
        },
        // Turn 1: 369KB doc
        {
          id: "call_mcp_doc1",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_use",
          created_at: 101,
          mcp_server_name: "feishu-kb",
          name: "docx_v1_document_rawContent",
          input: { document_id: "doc_1" },
        } as AgentToolUseEvent,
        {
          id: "evt_res_1",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_result",
          created_at: 102,
          mcp_tool_use_id: "call_mcp_doc1",
          content: doc369k,
        } as AgentMcpToolResultEvent,
        // Turn 2: 148KB doc
        {
          id: "call_mcp_doc2",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_use",
          created_at: 103,
          mcp_server_name: "feishu-kb",
          name: "docx_v1_document_rawContent",
          input: { document_id: "doc_2" },
        } as AgentToolUseEvent,
        {
          id: "evt_res_2",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_result",
          created_at: 104,
          mcp_tool_use_id: "call_mcp_doc2",
          content: doc148k,
        } as AgentMcpToolResultEvent,
        // Turn 3: 112KB doc
        {
          id: "call_mcp_doc3",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_use",
          created_at: 105,
          mcp_server_name: "feishu-kb",
          name: "docx_v1_document_rawContent",
          input: { document_id: "doc_3" },
        } as AgentToolUseEvent,
        {
          id: "evt_res_3",
          session_id: "sess_prod_replay",
          type: "agent.mcp_tool_result",
          created_at: 106,
          mcp_tool_use_id: "call_mcp_doc3",
          content: doc112k,
        } as AgentMcpToolResultEvent,
      ];

      // 1. Derive model messages
      const modelMessages = eventsToMessages(events);

      // 2. Estimate tokens for derived model messages
      const estimatedTokens = estimateMessagesTokens(modelMessages);
      const minimaxWindow = resolveContextWindowTokens("minimax-m2.7");
      const usableTokens = computeUsableInputTokens(minimaxWindow);

      // Without governance, raw text would be >230,000 tokens (exceeding MiniMax 204,800 limit).
      // With governance, estimated tokens MUST be bounded well below usable budget (< 15,000 tokens)!
      expect(minimaxWindow).toBe(204_800);
      expect(estimatedTokens).toBeLessThan(15_000);
      expect(estimatedTokens).toBeLessThan(usableTokens);

      // 3. Verify Invariant I1: Event log raw contents are strictly unmutated
      expect((events[2] as AgentMcpToolResultEvent).content.length).toBe(doc369k.length);
      expect((events[4] as AgentMcpToolResultEvent).content.length).toBe(doc148k.length);
      expect((events[6] as AgentMcpToolResultEvent).content.length).toBe(doc112k.length);

      // 4. Verify Invariant I4: All tool results are closed and reference their workspace paths
      const toolMessages = modelMessages.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBe(3);

      for (let i = 0; i < toolMessages.length; i++) {
        const tm = toolMessages[i];
        const part = (tm.content as any[])[0];
        expect(part.type).toBe("tool-result");
        expect(part.toolCallId).toBe(`call_mcp_doc${i + 1}`);

        const json = JSON.parse(part.output.value);
        expect(json.status).toBe("externalized");
        expect(json.workspace_path).toBe(`/workspace/.mcp/call_mcp_doc${i + 1}.txt`);
        expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  describe("buildEmergencyPrunedContext", () => {
    it("preserves conversation summary with real array content block shape [{type: 'text', text: '...'}]", () => {
      const msgs: any[] = [
        { role: "user", content: [{ type: "text", text: "<conversation-summary>\nPrior summary text\n</conversation-summary>" }] },
        { role: "user", content: "old message 1" },
        { role: "assistant", content: "old message 2" },
        { role: "user", content: "recent user message" },
        { role: "assistant", content: "recent assistant reply" },
      ];
      const pruned = buildEmergencyPrunedContext(msgs);
      expect(pruned.length).toBe(3);
      expect(pruned[0].role).toBe("user");
      expect(Array.isArray(pruned[0].content)).toBe(true);
      expect((pruned[0].content as any[])[0].text).toContain("<conversation-summary>");
      expect(pruned[1].role).toBe("user");
      expect(pruned[1].content).toBe("recent user message");
      expect(pruned[2].role).toBe("assistant");
      expect(pruned[2].content).toBe("recent assistant reply");
    });

    it("preserves complete assistant tool-call plus multiple matching tool result messages and trailing messages", () => {
      const msgs: any[] = [
        { role: "user", content: [{ type: "text", text: "<conversation-summary>summary</conversation-summary>" }] },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "read", args: { path: "a.txt" } },
            { type: "tool-call", toolCallId: "call_2", toolName: "read", args: { path: "b.txt" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", output: { type: "text", value: "content a" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_2", output: { type: "text", value: "content b" } }],
        },
        { role: "assistant", content: "Based on both files, here is the answer." },
        { role: "user", content: "Great, now do step 2." },
      ];
      const pruned = buildEmergencyPrunedContext(msgs);
      // Last 2 messages are: assistant ("Based on..."), user ("Great, now...")
      // They don't have tool results, so they don't drag earlier tool calls.
      expect(pruned.length).toBe(3);
      expect(pruned[0].role).toBe("user");
      expect((pruned[0].content as any[])[0].text).toContain("<conversation-summary>");
      expect(pruned[1].content).toBe("Based on both files, here is the answer.");
      expect(pruned[2].content).toBe("Great, now do step 2.");
    });

    it("expands to include assistant tool-call message when tool-result messages are in the tail", () => {
      const msgs: any[] = [
        { role: "user", content: [{ type: "text", text: "<conversation-summary>summary</conversation-summary>" }] },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "write", args: {} },
            { type: "tool-call", toolCallId: "call_2", toolName: "bash", args: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_1", output: { type: "text", value: "ok" } },
            { type: "tool-result", toolCallId: "call_2", output: { type: "text", value: "done" } },
          ],
        },
      ];
      const pruned = buildEmergencyPrunedContext(msgs);
      // Last message is the tool results message. It MUST pull in the assistant message that issued call_1 & call_2!
      expect(pruned.length).toBe(3);
      expect(pruned[0].role).toBe("user");
      expect((pruned[0].content as any[])[0].text).toContain("<conversation-summary>");
      expect(pruned[1].role).toBe("assistant");
      expect((pruned[1].content as any[])[0].toolCallId).toBe("call_1");
      expect(pruned[2].role).toBe("tool");
    });
  });
});
