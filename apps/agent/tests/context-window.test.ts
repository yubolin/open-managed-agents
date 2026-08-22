import { describe, it, expect } from "vitest";
import {
  resolveContextWindowTokens,
  computeUsableInputTokens,
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

  it("honors explicit ModelCard context_window_tokens", () => {
    const card = { context_window_tokens: 500_000 };
    expect(resolveContextWindowTokens("minimax-m2.7", card)).toBe(500_000);
  });

  it("computes usable input tokens subtracting output and protocol reserves", () => {
    const window = 204_800;
    const usable = computeUsableInputTokens(window, 8192, 4096);
    expect(usable).toBe(192_512);
  });
});
