import type { Logger } from "./logger.js";

// Talks to OMA main-node over the same boundary the future Feishu Provider
// will use: POST /v1/sessions/:id/messages (one-shot user.message + SSE stream
// until session.status_idle). See packages/http-routes/src/sessions/index.ts.

export interface OmaReply {
  text: string;
  frames: number;
}

export interface OmaClient {
  reply(sessionId: string, userText: string): Promise<OmaReply>;
}

interface OmaOptions {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
  timeoutMs?: number;
}

export function createOmaClient(opts: OmaOptions): OmaClient {
  const { baseUrl, apiKey, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = baseUrl.replace(/\/+$/, "");

  return {
    async reply(sessionId: string, userText: string): Promise<OmaReply> {
      const url = `${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let frames = 0;
      const parts: string[] = [];

      try {
        const res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({ content: userText }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new Error(`OMA HTTP ${res.status}: ${detail.slice(0, 300)}`);
        }

        await consumeSse(res.body, (frame) => {
          frames++;
          const delta = extractDeltaText(frame.parsed);
          if (delta) parts.push(delta);
          // The /messages stream closes on session.status_idle, but we also
          // short-circuit to release the connection ASAP.
          return frame.event !== "session.status_idle";
        });

        const text = parts.join("").trim();
        if (!text) {
          logger.warn({ op: "oma.empty_reply", frames }, "OMA stream yielded no assistant text");
        }
        return { text, frames };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface SseFrame {
  event: string;
  data: string;
  parsed: unknown;
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseFrame(raw);
        if (!frame) continue;
        const keepGoing = onFrame(frame);
        if (!keepGoing) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(data);
  } catch {
    /* leave parsed undefined for non-JSON data frames */
  }
  return { event, data, parsed };
}

// Only Anthropic-style content_block_delta carries the streamed assistant text
// in this endpoint (the stream is opened with include:["chunks"]). We ignore
// other shapes to avoid double-counting a final assistant.message.
function extractDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const obj = parsed as { type?: string; delta?: { text?: unknown } };
  if (obj.type !== "content_block_delta") return "";
  const t = obj.delta?.text;
  return typeof t === "string" ? t : "";
}
