import { describe, it, expect } from "vitest";
import {
  resolveContextWindowTokens,
  computeUsableInputTokens,
  UnknownModelContextWindowError,
} from "../src/harness/context-window";

describe("context-window", () => {
  it("resolves MiniMax models case-insensitively to 204,800 tokens", () => {
    expect(resolveContextWindowTokens("minimax-m2.7")).toBe(204_800);
    expect(resolveContextWindowTokens("MiniMax-Text-01")).toBe(204_800);
    expect(resolveContextWindowTokens("MINIMAX-M2.7")).toBe(204_800);
    expect(resolveContextWindowTokens({ modelId: "minimax-m2.7" } as any)).toBe(204_800);
  });

  it("resolves Claude 4.6 / 4.7 1M context models", () => {
    expect(resolveContextWindowTokens("claude-sonnet-4-6")).toBe(1_000_000);
    expect(resolveContextWindowTokens("claude-opus-4-7")).toBe(1_000_000);
    expect(resolveContextWindowTokens("claude-opus-4-6")).toBe(1_000_000);
  });

  it("resolves Claude 3.5 / Haiku 4.5 200k context models", () => {
    expect(resolveContextWindowTokens("claude-3-5-sonnet-latest")).toBe(200_000);
    expect(resolveContextWindowTokens("claude-haiku-4-5")).toBe(200_000);
  });

  it("honors explicit ModelCard context_window_tokens on unknown models", () => {
    const card = { context_window_tokens: 32_768 };
    expect(resolveContextWindowTokens("custom-private-llm-v1", card)).toBe(32_768);
  });

  it("fails closed with UnknownModelContextWindowError on unknown model without explicit modelCard window", () => {
    expect(() => resolveContextWindowTokens("unknown-vendor-model")).toThrow(UnknownModelContextWindowError);
    expect(() => resolveContextWindowTokens("")).toThrow(UnknownModelContextWindowError);
    expect(() => resolveContextWindowTokens({} as any)).toThrow(UnknownModelContextWindowError);
  });

  it("does not accept deceptive MiniMax substrings and exposes structured failure details", () => {
    expect(() => resolveContextWindowTokens("proxy-minimax-m2.7-unknown")).toThrow(
      UnknownModelContextWindowError,
    );
    try {
      resolveContextWindowTokens("proxy-minimax-m2.7-unknown");
      throw new Error("expected context window resolution to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "context_window_unknown",
        details: { model_id: "proxy-minimax-m2.7-unknown" },
      });
    }
  });

  it("computes usable input tokens subtracting output and protocol reserves", () => {
    const window = 204_800;
    const usable = computeUsableInputTokens(window, 8192, 4096);
    expect(usable).toBe(192_512);
  });
});
