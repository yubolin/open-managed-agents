import type { ContentBlock } from "@open-managed-agents/shared";
import type { SandboxExecutor } from "./interface";

/**
 * Maximum character limit for inline tool results in the model context projection.
 * Above this limit, results are projected as bounded head/tail previews with
 * workspace references.
 */
export const MAX_INLINE_RESULT_CHARS = 12_000;
export const PREVIEW_HEAD_CHARS = 2_000;
export const PREVIEW_TAIL_CHARS = 1_000;

/**
 * Pure SHA-256 implementation that runs synchronously in any JS runtime (Node / CF Workerd).
 */
export function sha256Hex(str: string): string {
  // Try node:crypto if available synchronously
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = globalThis.process?.versions?.node ? require("node:crypto") : null;
    if (nodeCrypto?.createHash) {
      return nodeCrypto.createHash("sha256").update(str, "utf8").digest("hex");
    }
  } catch {}

  // Fallback pure JS SHA-256 for non-node environments
  return fallbackSha256(str);
}

function fallbackSha256(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let ascii = "";
  for (let i = 0; i < bytes.length; i++) ascii += String.fromCharCode(bytes[i]);

  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = "";

  const words: number[] = [];
  const asciiBitLength = ascii.length * 8;

  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;

  const isPrime = (candidate: number) => {
    for (let factor = 2, max = Math.sqrt(candidate); factor <= max; factor++) {
      if (candidate % factor === 0) return false;
    }
    return true;
  };

  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (isPrime(candidate)) {
      if (primeCounter < 8) {
        hash[primeCounter] = (mathPow(candidate, 1 / 2) * maxWord) | 0;
      }
      k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      primeCounter++;
    }
  }

  ascii += "\x80";
  while ((ascii.length % 64) - 56) ascii += "\x00";
  for (let i = 0; i < ascii.length; i++) {
    const j = ascii.charCodeAt(i);
    if (j >> 8) return ""; // non-ascii
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength | 0;

  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0);

    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2];

      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      const val = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      const word = i < 16 ? (w[i] = (w[i] | 0)) : (w[i] = val);

      const sA = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const t2 = (sA + maj) | 0;

      const sE = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const t1 = (hash[7] + sE + ch + k[i] + word) | 0;

      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + t1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (t1 + t2) | 0;
    }

    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (let i = 0; i < 8; i++) {
    for (let i2 = 3; i2 >= 0; i2--) {
      const b = (hash[i] >> (i2 * 8)) & 255;
      result += (b < 16 ? "0" : "") + b.toString(16);
    }
  }
  return result;
}

export interface ExternalizedToolResultProjection {
  status: "externalized";
  tool_call_id: string;
  tool_name: string;
  byte_length: number;
  char_length: number;
  sha256: string;
  preview: string;
  workspace_path: string;
  workspace_path_durability: "ephemeral_rebuildable";
  instruction: string;
}

/**
 * Extract raw text from string or ContentBlock[] representation.
 */
export function extractRawTextFromToolContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b.type === "text") return b.text;
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Project a tool result for the model context view.
 *
 * If content exceeds MAX_INLINE_RESULT_CHARS, returns a structured externalized
 * projection with head/tail preview and workspace path reference.
 */
export function projectToolResultForModel(
  content: string | ContentBlock[],
  toolCallId: string,
  toolName = "unknown",
): { isExternalized: boolean; output: string } {
  const rawText = extractRawTextFromToolContent(content);

  if (rawText.length <= MAX_INLINE_RESULT_CHARS) {
    return {
      isExternalized: false,
      output: typeof content === "string" ? content : JSON.stringify(content),
    };
  }

  const byteLength = new TextEncoder().encode(rawText).length;
  const hash = sha256Hex(rawText);

  const head = rawText.slice(0, PREVIEW_HEAD_CHARS);
  const tail = rawText.slice(rawText.length - PREVIEW_TAIL_CHARS);

  const preview = `${head}\n\n... [Content externalized due to size limit (${rawText.length} chars / ${byteLength} bytes). Head & tail preview shown above & below] ...\n\n${tail}`;

  const projection: ExternalizedToolResultProjection = {
    status: "externalized",
    tool_call_id: toolCallId,
    tool_name: toolName,
    byte_length: byteLength,
    char_length: rawText.length,
    sha256: hash,
    preview,
    workspace_path: `/workspace/.mcp/${toolCallId}.txt`,
    workspace_path_durability: "ephemeral_rebuildable",
    instruction:
      `The tool output is large (${byteLength} bytes) and was externalized for context stability. ` +
      `To inspect specific sections, use the \`read\` tool with offset/limit on \`/workspace/.mcp/${toolCallId}.txt\` or \`grep\`.`,
  };

  return {
    isExternalized: true,
    output: JSON.stringify(projection, null, 2),
  };
}

/**
 * Materialize full tool result to sandbox workspace if executor is available.
 * Ephemeral rebuildable cache (Invariant I3).
 */
export async function materializeToolResultToWorkspace(
  sandbox: SandboxExecutor | undefined,
  toolCallId: string,
  rawContent: string,
): Promise<void> {
  if (!sandbox || rawContent.length <= MAX_INLINE_RESULT_CHARS) return;

  const path = `/workspace/.mcp/${toolCallId}.txt`;
  await sandbox.writeFile(path, rawContent);
}

async function checkSandboxFileExists(sandbox: SandboxExecutor, path: string): Promise<boolean> {
  if (typeof sandbox.fileExists === "function") {
    return sandbox.fileExists(path);
  }
  try {
    await sandbox.readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild/materialize all externalized tool results from historical events into the sandbox workspace.
 * Ensures that after a sandbox restart, any `/workspace/.mcp/${toolCallId}.txt` referenced in history
 * exists on disk in the sandbox before subsequent turns execute.
 *
 * Checks file existence and only materializes missing files to avoid sequential write latency.
 * Returns the count of files actually written to the workspace.
 */
export async function rebuildExternalizedToolResultsFromEvents(
  sandbox: SandboxExecutor | undefined,
  events: Array<{ type: string; [key: string]: any }>,
): Promise<number> {
  if (!sandbox) return 0;
  let count = 0;
  for (const event of events) {
    if (event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result") {
      const toolCallId = event.tool_use_id ?? event.mcp_tool_use_id;
      if (!toolCallId || !event.content) continue;
      const rawText = extractRawTextFromToolContent(event.content);
      if (rawText.length > MAX_INLINE_RESULT_CHARS) {
        const path = `/workspace/.mcp/${toolCallId}.txt`;
        const exists = await checkSandboxFileExists(sandbox, path);
        if (!exists) {
          await materializeToolResultToWorkspace(sandbox, toolCallId, rawText);
          count++;
        }
      }
    }
  }
  return count;
}
