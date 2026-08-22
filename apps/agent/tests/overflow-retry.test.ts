import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { DefaultHarness } from "../src/harness/default-loop";
import { InMemoryHistory } from "../src/runtime/history";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../src/harness/context-window";
import { ContextOverflowError } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { LanguageModel } from "ai";

function createMockRuntime() {
  const history = new InMemoryHistory();
  const events: SessionEvent[] = [];
  const runtime: HarnessRuntime = {
    sessionId: "test-session-123",
    history,
    broadcast: (ev: SessionEvent) => {
      events.push(ev);
      history.append(ev);
    },
    broadcastChunk: async () => {},
    broadcastStreamStart: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
    broadcastToolInputStart: async () => {},
    broadcastToolInputChunk: async () => {},
    broadcastToolInputEnd: async () => {},
  };
  return { runtime, events, history };
}

describe("P0 Overflow retry governance & maxOutputTokens alignment", () => {
  it("prevents overflow replay when an earlier step in the attempt executed a tool", async () => {
    let toolExecutions = 0;
    let streamCallCount = 0;
    let maxOutputTokensReceived: number | undefined;

    const sideEffectTool = tool({
      description: "A tool with irreversible side-effects",
      parameters: z.object({ value: z.string().optional() }),
      execute: async () => {
        toolExecutions++;
        return "side effect completed";
      },
    });

    const mockModel = new MockLanguageModelV3({
      modelId: "minimax-m2.7",
      doStream: async (options: any) => {
        streamCallCount++;
        maxOutputTokensReceived = options.maxOutputTokens;

        if (streamCallCount === 1) {
          // Step 1: Model invokes sideEffectTool
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call_step1",
                  toolName: "sideEffectTool",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 20, text: 20, reasoning: undefined },
                  },
                },
              ],
            }),
          };
        }

        if (streamCallCount === 2) {
          // Step 2: Context overflow error after tool executed
          const overflowErr = new Error("context window exceeds limit");
          (overflowErr as any).statusCode = 400;
          (overflowErr as any).responseBody = JSON.stringify({
            base_resp: { status_code: 2013, status_msg: "context window exceeds limit" },
          });
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "error", error: overflowErr },
              ],
            }),
          };
        }

        throw new Error(`Unexpected streamCallCount: ${streamCallCount}`);
      },
    });

    const { runtime } = createMockRuntime();
    const harness = new DefaultHarness();

    const userMessage: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: "Run the task" }],
    };
    runtime.broadcast(userMessage);

    const ctx: HarnessContext = {
      agent: {
        id: "agent_1",
        name: "test-agent",
        model: "minimax-m2.7",
        system: "You are a test agent.",
      },
      model: mockModel as unknown as LanguageModel,
      tools: { sideEffectTool },
      runtime,
      userMessage,
      session_id: "test-session-123",
      env: {},
    };

    // The harness must reject with ContextOverflowError and NOT retry (streamCallCount should be 2, toolExecutions should be 1)
    await expect(harness.run(ctx)).rejects.toThrow(ContextOverflowError);

    expect(toolExecutions).toBe(1);
    expect(streamCallCount).toBe(2);
    expect(maxOutputTokensReceived).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("retries cleanly on attempt 1 when no side-effect tools or tokens were emitted", async () => {
    let streamCallCount = 0;
    const promptMessageCounts: number[] = [];

    const mockModel = new MockLanguageModelV3({
      modelId: "minimax-m2.7",
      doStream: async (options: any) => {
        streamCallCount++;
        promptMessageCounts.push(options.prompt?.length ?? 0);

        if (streamCallCount === 1) {
          // Attempt 1 fails immediately with context overflow (no chunks, no tools)
          const overflowErr = new Error("context window exceeds limit");
          (overflowErr as any).statusCode = 400;
          (overflowErr as any).responseBody = JSON.stringify({
            base_resp: { status_code: 2013, status_msg: "context window exceeds limit" },
          });
          return {
            stream: simulateReadableStream({
              chunks: [{ type: "error", error: overflowErr }],
            }),
          };
        }

        // Attempt 2 succeeds with pruned context
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: "Recovered" },
              { type: "text-end", id: "t2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });

    const { runtime } = createMockRuntime();
    const harness = new DefaultHarness();

    // Populate history with 25 turns so emergency pruning has material to prune
    for (let i = 0; i < 25; i++) {
      runtime.broadcast({
        type: "user.message",
        content: [{ type: "text", text: `User message ${i}` }],
      });
      runtime.broadcast({
        type: "agent.message",
        content: [{ type: "text", text: `Agent response ${i}` }],
      });
    }

    const userMessage: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: "Latest turn" }],
    };
    runtime.broadcast(userMessage);

    const ctx: HarnessContext = {
      agent: {
        id: "agent_1",
        name: "test-agent",
        model: "minimax-m2.7",
        system: "You are a test agent.",
      },
      model: mockModel as unknown as LanguageModel,
      tools: {},
      runtime,
      userMessage,
      session_id: "test-session-123",
      env: {},
    };

    await harness.run(ctx);

    expect(streamCallCount).toBe(2);
    // Attempt 1 had full messages, Attempt 2 had emergency-pruned messages (kept summary + tail)
    expect(promptMessageCounts[0]).toBeGreaterThan(promptMessageCounts[1]);
  });

  it("passes maxOutputTokens to streamText matching the context budget", async () => {
    let capturedMaxOutputTokens: number | undefined;

    const mockModel = new MockLanguageModelV3({
      modelId: "minimax-m2.7",
      doStream: async (options: any) => {
        capturedMaxOutputTokens = options.maxOutputTokens;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hello world" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });

    const { runtime } = createMockRuntime();
    const harness = new DefaultHarness();

    const userMessage: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: "Hi" }],
    };
    runtime.broadcast(userMessage);

    const ctx: HarnessContext = {
      agent: {
        id: "agent_1",
        name: "test-agent",
        model: "minimax-m2.7",
        system: "You are a test agent.",
      },
      model: mockModel as unknown as LanguageModel,
      tools: {},
      runtime,
      userMessage,
      session_id: "test-session-123",
      env: {},
    };

    await harness.run(ctx);

    expect(capturedMaxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(capturedMaxOutputTokens).toBe(8_192);
  });
});
