import { describe, it, expect } from "vitest";
import {
  estimateTextTokens,
  estimateContentPartTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateFullContextTokens,
  IMAGE_TOKEN_SIZE,
} from "../src/harness/token-estimator";
import type { ModelMessage } from "ai";

describe("token-estimator", () => {
  it("estimates ASCII text accurately (~4 chars per token)", () => {
    const text = "Hello world! This is a simple English sentence."; // 47 chars
    const tokens = estimateTextTokens(text);
    // 47 * 0.25 = 11.75 -> ceil = 12
    expect(tokens).toBe(12);
  });

  it("estimates CJK Chinese characters with accurate weight (~1.25 tokens per char)", () => {
    const text = "这是一个关于飞书知识库文档检索与上下文治理的测试文本。"; // 27 CJK chars
    const tokens = estimateTextTokens(text);
    // 27 * 1.25 = 33.75 -> ceil = 34
    expect(tokens).toBe(34);
    // Naive length / 4 would give 7 tokens, severely underestimating by almost 5x!
    expect(tokens).toBeGreaterThan(Math.ceil(text.length / 4) * 4);
  });

  it("handles mixed Chinese and English text", () => {
    const text = "MiniMax M2.7 模型上下文窗口是 204,800 tokens。";
    // "MiniMax M2.7 " (13 ascii) + "模型上下文窗口是 " (8 CJK) + "204,800 tokens。" (15 ascii + 1 cjk)
    // ascii = 28 * 0.25 = 7; cjk = 9 * 1.25 = 11.25 -> total = 18.25 -> ceil = 19
    const tokens = estimateTextTokens(text);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(30);
  });

  it("handles Emojis and surrogate pairs correctly without splitting code points", () => {
    const text = "🚀🔥🤖✨🎉"; // 5 emojis (code points > 0xFFFF)
    const tokens = estimateTextTokens(text);
    // 5 * 2.0 = 10
    expect(tokens).toBe(10);
  });

  it("handles content parts including tool results, calls, and images", () => {
    expect(estimateContentPartTokens({ type: "text", text: "Test text" })).toBe(3);
    expect(estimateContentPartTokens({ type: "image", image: "data:..." })).toBe(IMAGE_TOKEN_SIZE);
    expect(estimateContentPartTokens({
      type: "tool-call",
      toolName: "read",
      input: { path: "/workspace/test.txt" },
    })).toBeGreaterThan(5);
  });

  it("estimates full messages and contexts including structural overhead", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "你好，请帮我查询飞书知识库文档。" },
      { role: "assistant", content: "好的，我正在调用知识库检索工具。" },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThanOrEqual(40);

    const fullTokens = estimateFullContextTokens({
      systemPrompt: "You are a helpful AIOps assistant.",
      tools: {
        read: { description: "Read file contents", parameters: { type: "object" } },
      },
      messages,
    });
    expect(fullTokens).toBeGreaterThan(tokens);
  });
});
