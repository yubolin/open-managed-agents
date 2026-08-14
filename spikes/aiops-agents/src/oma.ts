// OMA REST client — the ONLY integration surface of this sidecar.
//
// Everything goes through the public boundary (packages/http-routes):
//   GET  /v1/agents                    list agents (resolve name → id)
//   POST /v1/sessions                  { agent: "<id>", title? }
//   GET  /v1/sessions?agent_id=        list sessions of one agent (watch mode)
//   GET  /v1/sessions/:id/events       persisted event log (watch mode)
//   POST /v1/sessions/:id/messages     one-shot user.message + SSE stream
//                                      until session.status_idle
//
// The turn() SSE contract mirrors spikes/feishu-echo/src/oma.ts (the boundary
// the future Feishu Provider was validated against): accumulate text deltas,
// prefer the final complete message, stop at session.status_idle, bail
// immediately on session.error.

export interface OmaOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Required for cloud agents (POST /v1/sessions environment_id). */
  environmentId?: string;
}

export interface OmaReply {
  text: string;
  frames: number;
}

export interface SessionSummary {
  id: string;
  status?: string;
  title?: string;
}

export interface SessionEvent {
  type: string;
  content?: unknown;
  metadata?: Record<string, unknown> | null;
}

export class OmaClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly environmentId?: string;

  constructor(opts: OmaOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.environmentId = opts.environmentId || undefined;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  /** List agents; returns name → id (first active occurrence wins). */
  async listAgents(): Promise<Map<string, string>> {
    const res = await fetch(`${this.base}/v1/agents`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`list agents failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    const payload = (await res.json()) as { data?: Array<{ id: string; name: string }> };
    const map = new Map<string, string>();
    for (const a of payload.data ?? []) {
      if (a?.id && a?.name && !map.has(a.name)) map.set(a.name, a.id);
    }
    return map;
  }

  /** Resolve one agent id by name; throws with the available roster on miss. */
  async requireAgent(name: string): Promise<string> {
    const agents = await this.listAgents();
    const id = agents.get(name);
    if (!id) {
      const known = [...agents.keys()].sort().join(", ") || "(none)";
      throw new Error(
        `agent "${name}" not found on ${this.base}. Available: ${known}. ` +
          `Run scripts/seed-aiops-digital-employees.ts first.`,
      );
    }
    return id;
  }

  /** Create an idle session bound to an agent. */
  async createSession(agentId: string, title?: string): Promise<string> {
    const res = await fetch(`${this.base}/v1/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        agent: agentId,
        ...(this.environmentId ? { environment_id: this.environmentId } : {}),
        ...(title ? { title } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`create session failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    const payload = (await res.json()) as {
      id?: string;
      data?: { id?: string };
      session?: { id?: string };
    };
    const id = payload.id ?? payload.data?.id ?? payload.session?.id;
    if (!id) throw new Error(`create session returned no id: ${JSON.stringify(payload).slice(0, 300)}`);
    return id;
  }

  /** One-shot turn: append a user.message, stream until the turn ends. */
  async turn(sessionId: string, userText: string): Promise<OmaReply> {
    const url = `${this.base}/v1/sessions/${encodeURIComponent(sessionId)}/messages`;
    const startedAt = Date.now();

    let frames = 0;
    const parts: string[] = [];
    let finalText = "";
    let streamError: string | null = null;
    let sawTurnSignal = false;
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ accept: "text/event-stream" }),
      body: JSON.stringify({ content: userText }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`turn failed: HTTP ${res.status} ${await safeText(res)}`);
    }

    const consume = consumeSse(res.body, (frame) => {
      frames++;
      const delta = extractDeltaText(frame.parsed);
      if (delta) parts.push(delta);
      const complete = extractMessageText(frame.parsed);
      if (complete) finalText = complete;
      if (frame.event === "session.error") {
        streamError = extractErrorMessage(frame.parsed) ?? "session.error";
        settle();
        return false;
      }
      if (frame.event === "session.status_idle") {
        settle();
        return false;
      }
      if (frame.event === "agent.message" || frame.event === "span.model_request_end") {
        sawTurnSignal = true;
      }
      return true;
    });

    // The /messages SSE boundary does not reliably deliver session.status_idle
    // (observed live: the stream stays open after span.model_request_end), so
    // corroborate the terminal condition with the session's persisted status.
    const poller = (async () => {
      while (Date.now() - startedAt < this.timeoutMs) {
        await sleep(500);
        if (frames === 0 || !sawTurnSignal) continue;
        const status = await this.statusOf(sessionId);
        if (status === "idle" || status === "terminated") {
          settle();
          return;
        }
      }
    })();

    const timeout = sleep(this.timeoutMs).then(() => settle());
    await Promise.race([settled, consume]);
    void timeout;
    await res.body.cancel().catch(() => {});

    if (streamError) throw new Error(`OMA session.error: ${streamError}`);
    const text = (finalText || parts.join("")).trim();
    return { text, frames };
  }

  /** Current persisted session status (idle | running | …); "" when unknown. */
  private async statusOf(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`${this.base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        headers: this.headers(),
      });
      if (!res.ok) return "";
      const payload = (await res.json()) as {
        status?: string;
        data?: { status?: string };
      };
      return payload.status ?? payload.data?.status ?? "";
    } catch {
      return "";
    }
  }

  /** Sessions of one agent (most recent first, platform-defined order). */
  async listSessions(agentId: string, limit = 50): Promise<SessionSummary[]> {
    const res = await fetch(
      `${this.base}/v1/sessions?agent_id=${encodeURIComponent(agentId)}&limit=${limit}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`list sessions failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    const payload = (await res.json()) as { data?: Array<{ id?: string; status?: string; title?: string }> };
    return (payload.data ?? [])
      .filter((s): s is { id: string; status?: string; title?: string } => typeof s?.id === "string")
      .map((s) => ({ id: s.id, status: s.status, title: s.title }));
  }

  /** Persisted event log (JSON polling — watch mode). */
  async getEvents(sessionId: string): Promise<SessionEvent[]> {
    const res = await fetch(`${this.base}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`get events failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    const payload = (await res.json()) as { data?: SessionEvent[] } | SessionEvent[];
    return Array.isArray(payload) ? payload : (payload.data ?? []);
  }
}

// ─── SSE plumbing (mirrors spikes/feishu-echo/src/oma.ts) ──────────────────

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
        if (!onFrame(frame)) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  let parsed: unknown = data;
  try {
    parsed = JSON.parse(data);
  } catch {
    /* non-JSON data frames pass through as raw strings */
  }
  return { event, data, parsed };
}

/** Concatenate text blocks of an agent.message-shaped payload. */
function extractMessageText(parsed: unknown): string {
  const content = (parsed as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function extractDeltaText(parsed: unknown): string {
  // agent.message_chunk frames carry the delta as a bare string; Anthropic
  // style content_block_delta wraps it in { delta: { text } }.
  const asChunk = parsed as { type?: string; delta?: unknown };
  if (asChunk?.type === "agent.message_chunk" && typeof asChunk.delta === "string") {
    return asChunk.delta;
  }
  const delta = (parsed as { delta?: { text?: unknown } })?.delta;
  if (delta && typeof delta.text === "string") return delta.text;
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(parsed: unknown): string | null {
  const err = (parsed as { error?: { message?: unknown } | string })?.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Public helper reused by watch.ts for event-log text extraction. */
export function eventText(event: SessionEvent): string {
  return extractMessageText(event);
}
