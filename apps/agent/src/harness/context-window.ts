import type { LanguageModel } from "ai";

/** Default reserve parameters for prompt headroom */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_PROTOCOL_RESERVE_TOKENS = 4_096;

/**
 * Resolve the context window in tokens for a given model and optional ModelCard config.
 *
 * Priority:
 * 1. Explicit `modelCard.context_window_tokens`
 * 2. Case-insensitive model ID catalog lookup
 * 3. Safe baseline fallback (200,000 tokens)
 */
export function resolveContextWindowTokens(
  model: LanguageModel | string,
  modelCard?: { context_window_tokens?: number } | null,
): number {
  if (modelCard?.context_window_tokens && modelCard.context_window_tokens > 0) {
    return modelCard.context_window_tokens;
  }

  const rawId = (model as { modelId?: string })?.modelId ?? (typeof model === "string" ? model : "");
  if (!rawId || typeof rawId !== "string") {
    return 200_000;
  }

  const id = rawId.toLowerCase();

  // MiniMax models: M2.7, Text-01, etc. -> 204,800 tokens
  if (id.includes("minimax")) {
    return 204_800;
  }

  // Claude 4.6+ / 4.7 1M context models
  if (id.includes("opus-4-7") || id.includes("opus-4-6") || id.includes("sonnet-4-6")) {
    return 1_000_000;
  }

  // Claude 3.5 / Haiku 4.5 / Claude 3 standard 200k models
  if (
    id.includes("haiku-4-5") ||
    id.includes("haiku") ||
    id.includes("claude-3-5") ||
    id.includes("claude-3") ||
    id.includes("opus") ||
    id.includes("sonnet")
  ) {
    return 200_000;
  }

  // OpenAI GPT-4o / GPT-4.5 / O1 / O3 models
  if (id.includes("gpt-4.5") || id.includes("o1") || id.includes("o3")) {
    return 200_000;
  }
  if (id.includes("gpt-4o") || id.includes("gpt-4")) {
    return 128_000;
  }

  // DeepSeek V3 / R1 models (64k - 128k context)
  if (id.includes("deepseek")) {
    return 64_000;
  }

  // Safe fallback
  return 200_000;
}

/**
 * Compute the maximum usable input token budget before triggering compaction or hard limit.
 */
export function computeUsableInputTokens(
  contextWindowTokens: number,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  protocolReserve = DEFAULT_PROTOCOL_RESERVE_TOKENS,
): number {
  return Math.max(1_024, contextWindowTokens - maxOutputTokens - protocolReserve);
}
