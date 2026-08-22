import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { DefaultHarness } from "../src/harness/default-loop";
import { buildTools } from "../src/harness/tools";
import { InMemoryHistory } from "../src/runtime/history";
import type { HarnessContext, HarnessRuntime, SandboxExecutor } from "../src/harness/interface";
import type { SessionEvent } from "@open-managed-agents/shared";

function runtimeWithSandbox(sandbox: SandboxExecutor): HarnessRuntime {
  const history = new InMemoryHistory();
  return {
    sessionId: "large-result-current-step",
    history,
    sandbox,
    broadcast: (event) => history.append(event),
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
}

describe("current-step large tool result projection", () => {
  it("projects the next provider request while retaining raw durable history", async () => {
    const uniqueMiddle = "UNIQUE_RAW_MIDDLE_MUST_NOT_REACH_PROVIDER";
    const rawResult = `${"A".repeat(6_000)}${uniqueMiddle}${"Z".repeat(7_000)}`;
    const written: Record<string, string> = {};
    let materialized = false;
    let modelCalls = 0;

    const sandbox: SandboxExecutor = {
      exec: async () => rawResult,
      writeFile: async (path, content) => {
        written[path] = content;
        materialized = true;
      },
      readFile: async () => "",
      fileExists: async () => false,
    };

    const tools = await buildTools(
      { name: "large-result-agent", tools: [{ name: "bash", enabled: true }] } as any,
      sandbox,
      { ANTHROPIC_API_KEY: "test" },
    );

    const model = new MockLanguageModelV3({
      modelId: "minimax-m2.7",
      doStream: async (options: any) => {
        modelCalls++;
        if (modelCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call_large_bash",
                  toolName: "bash",
                  input: JSON.stringify({ command: "produce-large-output" }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: { total: 20, noCache: 20 },
                    outputTokens: { total: 10, text: 10 },
                  },
                },
              ],
            }),
          };
        }

        expect(materialized).toBe(true);
        const providerPrompt = JSON.stringify(options.prompt);
        expect(providerPrompt).not.toContain(uniqueMiddle);
        expect(providerPrompt).toContain("/workspace/.mcp/call_large_bash.txt");
        expect(providerPrompt).toContain("sha256");

        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "done" },
              { type: "text-end", id: "answer" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 30, noCache: 30 },
                  outputTokens: { total: 5, text: 5 },
                },
              },
            ],
          }),
        };
      },
    });

    const runtime = runtimeWithSandbox(sandbox);
    const userMessage: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: "run the large output tool" }],
    };
    runtime.broadcast(userMessage);

    const ctx: HarnessContext = {
      agent: {
        id: "agent_large_result",
        name: "large-result-agent",
        model: "minimax-m2.7",
        system: "Run the requested tool.",
      },
      model: model as unknown as LanguageModel,
      tools,
      runtime,
      userMessage,
      session_id: runtime.sessionId,
      env: {},
    };

    await new DefaultHarness().run(ctx);

    expect(modelCalls).toBe(2);
    expect(written["/workspace/.mcp/call_large_bash.txt"]).toBe(rawResult);
    const rawEvent = runtime.history
      .getEvents()
      .find((event) => event.type === "agent.tool_result" && event.tool_use_id === "call_large_bash");
    expect(rawEvent?.content).toBe(rawResult);
  });
});
