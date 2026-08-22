import type { ModelMessage } from "ai";

/** Standard image token estimate heuristic */
export const IMAGE_TOKEN_SIZE = 2_000;

/**
 * Unicode CodePoint aware text token estimator.
 *
 * Traditional `length / 4` assumes ~4 characters per token, which works for English
 * ASCII but severely undercounts CJK (Chinese/Japanese/Korean) text where 1 character
 * is typically 1 to 2 tokens.
 *
 * Weighting baseline:
 * - ASCII (<= 0x7F): ~0.25 tokens/char (4 chars/token)
 * - CJK Ideographs, Kana, Hangul, CJK Punctuation: ~1.25 tokens/char
 * - Emojis & Supplementary Multilingual Plane (> 0xFFFF): ~2.0 tokens/symbol
 * - Other Unicode scripts (Cyrillic, Arabic, accented Latin, etc.): ~1.5 tokens/char
 */
export function estimateTextTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  let asciiCount = 0;
  let cjkCount = 0;
  let emojiCount = 0;
  let otherCount = 0;

  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;

    if (cp <= 0x7F) {
      asciiCount++;
    } else if (
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Extension A
      (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
      (cp >= 0x3040 && cp <= 0x309F) || // Hiragana
      (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana
      (cp >= 0xAC00 && cp <= 0xD7AF) || // Hangul Syllables
      (cp >= 0x3000 && cp <= 0x303F) || // CJK Symbols and Punctuation
      (cp >= 0xFF00 && cp <= 0xFFEF) // Halfwidth and Fullwidth Forms
    ) {
      cjkCount++;
    } else if (cp > 0xFFFF) {
      emojiCount++;
    } else {
      otherCount++;
    }
  }

  const raw = asciiCount * 0.25 + cjkCount * 1.25 + emojiCount * 2.0 + otherCount * 1.5;
  return Math.ceil(raw);
}

/**
 * Estimate tokens for a tool result payload.
 */
export function estimateToolResultTokens(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text") {
    return estimateTextTokens(typeof o.value === "string" ? o.value : JSON.stringify(o.value ?? ""));
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    let sum = 0;
    for (const item of o.value) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if (it.type === "text") {
          sum += estimateTextTokens(it.text ?? "");
        } else if (
          it.type === "image-data" ||
          it.type === "image-url" ||
          it.type === "file-data" ||
          it.type === "file-url"
        ) {
          sum += IMAGE_TOKEN_SIZE;
        } else {
          sum += estimateTextTokens(JSON.stringify(item));
        }
      }
    }
    return sum;
  }
  return estimateTextTokens(JSON.stringify(output));
}

/**
 * Estimate tokens for a single ModelMessage content part.
 */
export function estimateContentPartTokens(part: unknown): number {
  if (typeof part === "string") return estimateTextTokens(part);
  if (!part || typeof part !== "object") return 0;
  const p = part as { type?: string; [k: string]: unknown };
  switch (p.type) {
    case "text":
      return estimateTextTokens((p.text as string) ?? "");
    case "reasoning":
      return estimateTextTokens((p.text as string) ?? "");
    case "tool-call":
      return estimateTextTokens(((p.toolName as string) ?? "") + JSON.stringify(p.input ?? {}));
    case "tool-result":
      return estimateToolResultTokens(p.output);
    case "image":
    case "file":
      return IMAGE_TOKEN_SIZE;
    default:
      return estimateTextTokens(JSON.stringify(part));
  }
}

/**
 * Estimate tokens for a single ModelMessage.
 */
export function estimateMessageTokens(m: ModelMessage): number {
  if (!m) return 0;
  let total = 0;
  if (typeof m.content === "string") {
    total = estimateTextTokens(m.content);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      total += estimateContentPartTokens(part);
    }
  }
  return total;
}

/**
 * Estimate total tokens across an array of ModelMessage items.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m);
  }
  return total;
}

/**
 * Estimate tokens for system prompt.
 */
export function estimateSystemPromptTokens(systemPrompt?: string | unknown): number {
  if (!systemPrompt) return 0;
  if (typeof systemPrompt === "string") return estimateTextTokens(systemPrompt) + 4;
  return estimateTextTokens(JSON.stringify(systemPrompt)) + 4;
}

/**
 * Estimate tokens for registered tools and schemas.
 */
export function estimateToolSchemaTokens(tools?: Record<string, unknown>): number {
  if (!tools || Object.keys(tools).length === 0) return 0;
  let total = 0;
  for (const [name, def] of Object.entries(tools)) {
    // Each tool has name, description, parameters schema
    const str = name + JSON.stringify(def ?? {});
    total += estimateTextTokens(str) + 8;
  }
  return total;
}

/**
 * Estimate total tokens for a full LLM invocation (system + tools + messages).
 */
export function estimateFullContextTokens(opts: {
  systemPrompt?: string | unknown;
  tools?: Record<string, unknown>;
  messages: ModelMessage[];
}): number {
  const systemTokens = estimateSystemPromptTokens(opts.systemPrompt);
  const toolTokens = estimateToolSchemaTokens(opts.tools);
  const messageTokens = estimateMessagesTokens(opts.messages);
  // Protocol reserve overhead (top-level schema, generation priming) ~16 tokens
  return systemTokens + toolTokens + messageTokens + 16;
}
