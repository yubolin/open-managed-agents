import { streamText, stepCountIs, wrapLanguageModel } from "ai";
import type { ContentPart, ModelMessage, LanguageModel, SystemModelMessage } from "ai";
import type { HarnessInterface, HarnessContext, HarnessRuntime, FileResolver } from "./interface";
import type { SessionEvent, ContentBlock, AgentToolUseEvent } from "@open-managed-agents/shared";
import { generateEventId, classifyExternalError, ModelError, ContextOverflowError } from "@open-managed-agents/shared";
import { eventsToMessagesAsync } from "../runtime/history";
import { SummarizeCompactionStrategy, resolveCompactionStrategy } from "./compaction";
import type { CompactionStrategy } from "./compaction";
import { ALL_TOOLS } from "./tools";
import { llmLoggingMiddleware, llmLogKey } from "./llm-logging-middleware";
import { resolveContextWindowTokens, computeUsableInputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from "./context-window";
import {
  projectToolResultForModel,
  rebuildExternalizedToolResultsFromEvents,
} from "./large-tool-result-guard";
import {
  estimateFullContextTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
} from "./token-estimator";

// Single source of truth lives in ./tools.ts (ALL_TOOLS). Importing here so
// adding a new toolset entry can't drift the event-classification list — the
// previous hard-coded duplicate caused `browser`, `schedule`,
// `cancel_schedule`, and `list_schedules` to mis-emit as
// `agent.custom_tool_use` instead of `agent.tool_use`.
const BUILTIN_TOOLS = new Set(ALL_TOOLS);
const isMcpTool = (name: string) => name.startsWith("mcp_");
// Exported so tests can assert classification directly. Returning true here
// makes `runtime.broadcast` emit `agent.tool_use`; false routes to
// `agent.custom_tool_use`. Down-stream consumers (Console UI, SDK event
// filters, billing dashboards) split on those event types.
export const isBuiltinTool = (name: string): boolean =>
  BUILTIN_TOOLS.has(name) || isMcpTool(name) || name.startsWith("call_agent_");

export interface ContextOverflowDiagnostic {
  isOverflow: boolean;
  statusCode?: number;
  providerCode?: number | string;
  providerMessage?: string;
}

/**
 * Identify provider-side context window / token overflow errors across providers.
 */
export function detectContextOverflowError(error: unknown): ContextOverflowDiagnostic {
  if (!error) return { isOverflow: false };
  const message = error instanceof Error ? error.message : String(error);
  let statusCode: number | undefined;
  let responseBody = "";
  if (typeof error === "object" && error !== null) {
    const e = error as { statusCode?: number; status?: number; responseBody?: string };
    statusCode = e.statusCode ?? e.status;
    if (typeof e.responseBody === "string") {
      responseBody = e.responseBody;
    }
  }
  const combined = `${message} ${responseBody}`.toLowerCase();
  const isOverflow =
    combined.includes("context window exceeds limit") ||
    combined.includes("context_length_exceeded") ||
    combined.includes("prompt is too long") ||
    combined.includes("prompt exceeds maximum context length") ||
    combined.includes("exceeds the context window") ||
    combined.includes("maximum context length") ||
    (statusCode === 400 && (combined.includes("2013") || combined.includes("context")));

  let providerCode: number | string | undefined;
  if (combined.includes("2013")) providerCode = 2013;

  return {
    isOverflow,
    statusCode: statusCode ?? (combined.includes("400") ? 400 : undefined),
    providerCode,
    providerMessage: responseBody ? `${message}: ${responseBody}` : message,
  };
}


/**
 * Extract the MCP server name from a tool name like "mcp_github_call" or "mcp_github_list_tools".
 */
function extractMcpServerName(toolName: string): string {
  // mcp_{server_name}_{call|list_tools}
  const withoutPrefix = toolName.slice(4); // Remove "mcp_"
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  // Handle _list_tools (two underscores)
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  if (lastUnderscore > 0) {
    return withoutPrefix.slice(0, lastUnderscore);
  }
  return withoutPrefix;
}

/**
 * Map a tool-call ContentPart to the right wire event family
 * (mcp / built-in / custom). Also emits agent.thread_message_sent for
 * call_agent_* sub-agent invocations.
 *
 * Lives outside DefaultHarness so the bijection contract is co-located
 * with `eventsToMessages` — the inverse mapping in history.ts.
 */
function emitToolCallEvent(
  runtime: HarnessContext["runtime"],
  tools: Record<string, any>,
  part: ContentPart<any> & { type: "tool-call" },
): void {
  const callInput = (part.input ?? {}) as Record<string, unknown>;
  const toolName = part.toolName;
  const toolCallId = part.toolCallId;

  if (toolName.startsWith("call_agent_")) {
    runtime.broadcast({
      type: "agent.thread_message_sent",
      to_thread_id: toolCallId,
      content: [{ type: "text", text: String(callInput.message || "") }],
      // v1-additive (docs/trajectory-v1-spec.md "Causality"): mint a
      // deterministic id keyed on toolCallId so the matching
      // `agent.thread_message_received` (emitted in emitToolResultEvent)
      // can set parent_event_id back to the same value. There is exactly
      // one sent / received pair per call_agent_* tool invocation, so
      // a derived-from-toolCallId id collides with nothing.
      id: threadSentEventId(toolCallId),
    });
  }

  if (isMcpTool(toolName)) {
    runtime.broadcast({
      type: "agent.mcp_tool_use",
      id: toolCallId,
      mcp_server_name: extractMcpServerName(toolName),
      name: toolName,
      input: callInput,
    });
  } else if (isBuiltinTool(toolName)) {
    const event: AgentToolUseEvent = {
      type: "agent.tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    };
    if (!tools[toolName]?.execute) event.evaluated_permission = "ask";
    runtime.broadcast(event);
  } else {
    runtime.broadcast({
      type: "agent.custom_tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    });
  }
}

/**
 * Deterministic id for the `agent.thread_message_sent` event paired with
 * a given call_agent_* tool invocation. Lets the eventual
 * `agent.thread_message_received` set parent_event_id = this id without
 * sharing state across the two emit callbacks.
 *
 * Format mirrors the `sevt-` prefix `generateEventId` mints so downstream
 * id-format sniffing keeps working.
 */
function threadSentEventId(toolCallId: string): string {
  return `sevt-thread-sent-${toolCallId}`;
}

/**
 * Map a tool-result (or tool-error) ContentPart to a wire event,
 * normalizing the AI SDK's ToolResultOutput union into the wire's
 * `string | ContentBlock[]` representation. Also emits
 * agent.thread_message_received for call_agent_*.
 *
 * Normalization rules — fixed so that read(write(m)) === m at byte level:
 *   text       → string
 *   content[]  → ContentBlock[] (TextBlock for text parts; image/document
 *                ContentBlocks pass through if already shaped that way)
 *   json/error → JSON-stringified string (lossy for the AI SDK type tag,
 *                but Anthropic only ever sees the string, so derive can
 *                rebuild a {type:"text"} ToolResultOutput equivalently)
 *   already-shaped ContentBlock or ContentBlock[] (legacy tool returns)
 *                → wrap or pass through
 */
function emitToolResultEvent(
  runtime: HarnessContext["runtime"],
  part: ContentPart<any> & { type: "tool-result" | "tool-error" },
): void {
  const toolCallId = part.toolCallId;
  const toolName = part.toolName;
  // tool-error has `error`, tool-result has `output`.
  const raw =
    part.type === "tool-error"
      ? { type: "error-text", value: String((part as any).error ?? "") }
      : ((part as any).output ?? (part as any).result);

  const content = normalizeToolOutputForWire(raw);

  if (isMcpTool(toolName)) {
    runtime.broadcast({
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: toolCallId,
      content: typeof content === "string" ? content : JSON.stringify(content),
      // v1-additive: causal predecessor is the matching agent.mcp_tool_use,
      // whose EventBase.id is set explicitly to toolCallId in
      // emitToolCallEvent above. Same identity, no extra plumbing.
      parent_event_id: toolCallId,
    });
  } else {
    runtime.broadcast({
      type: "agent.tool_result",
      tool_use_id: toolCallId,
      content,
      // v1-additive: causal predecessor is the matching agent.tool_use,
      // whose EventBase.id is set explicitly to toolCallId in
      // emitToolCallEvent above. (AgentToolUseEvent.id overrides
      // EventBase.id, so tool_use_id IS the parent's EventBase.id.)
      parent_event_id: toolCallId,
    });
  }

  if (toolName.startsWith("call_agent_")) {
    const text = typeof content === "string"
      ? content
      : content.map((b) => (b.type === "text" ? b.text : "")).join("");
    runtime.broadcast({
      type: "agent.thread_message_received",
      from_thread_id: toolCallId,
      content: [{ type: "text", text }],
      // v1-additive: causal predecessor is the agent.thread_message_sent
      // emitted in emitToolCallEvent above for the same toolCallId.
      parent_event_id: threadSentEventId(toolCallId),
    });
  }
}

/**
 * AI SDK ToolResultOutput union → wire `string | ContentBlock[]`.
 * Pure function; same input → same output bytes.
 */
function normalizeToolOutputForWire(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";

  // Already wire-shape (single ContentBlock or array)
  if (typeof raw === "object" && "type" in raw) {
    const r = raw as { type: string };
    if (r.type === "text" && "text" in raw) return [raw as ContentBlock];
    if (r.type === "image" && "source" in raw) return [raw as ContentBlock];
    if (r.type === "document" && "source" in raw) return [raw as ContentBlock];

    // AI SDK ToolResultOutput discriminated union
    if (r.type === "text" && "value" in raw) return String((raw as unknown as { value: unknown }).value);
    if (r.type === "json") return JSON.stringify((raw as unknown as { value: unknown }).value);
    if (r.type === "error-text" || r.type === "error-json") {
      const v = (raw as unknown as { value: unknown }).value;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    if (r.type === "execution-denied") {
      return JSON.stringify({ denied: true, reason: (raw as unknown as { reason?: string }).reason });
    }
    if (r.type === "content" && Array.isArray((raw as unknown as { value: unknown[] }).value)) {
      const parts = (raw as unknown as { value: Array<{ type: string; text?: string; data?: string; mediaType?: string; url?: string }> }).value;
      return parts.map((p): ContentBlock => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image-data" || p.type === "media") {
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "image-url") {
          return { type: "image", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        if (p.type === "file-data") {
          return {
            type: "document",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "file-url") {
          return { type: "document", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        return { type: "text", text: JSON.stringify(p) };
      });
    }
  }

  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "type" in b)) {
    return raw as ContentBlock[];
  }

  return JSON.stringify(raw);
}

export class DefaultHarness implements HarnessInterface {
  /**
   * Compaction strategy resolved from agent config. Cached on the harness
   * instance so shouldCompact / compact (which don't get ctx) can use it.
   * Set in run() before any compaction hook fires.
   */
  private compactionStrategy: CompactionStrategy = new SummarizeCompactionStrategy();

  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime, tools, model, systemPrompt } = ctx;

    // Resolve compaction params from agent config. Strategy class is
    // selectable via `agent.metadata.compaction_strategy` (defaults to
    // "summarize" for backward compat); shared knobs (tail, trigger
    // fraction) apply to whichever strategy is picked.
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const triggerFraction = typeof meta.compaction_trigger_fraction === "number"
      ? meta.compaction_trigger_fraction as number
      : undefined;
    const tailMinTokens = typeof meta.compaction_tail_min_tokens === "number"
      ? meta.compaction_tail_min_tokens as number
      : undefined;
    const tailMaxTokens = typeof meta.compaction_tail_max_tokens === "number"
      ? meta.compaction_tail_max_tokens as number
      : undefined;
    const tailMinMessages = typeof meta.compaction_tail_min_messages === "number"
      ? meta.compaction_tail_min_messages as number
      : undefined;
    const strategyName = typeof meta.compaction_strategy === "string"
      ? meta.compaction_strategy as string
      : undefined;
    this.compactionStrategy = resolveCompactionStrategy(strategyName, {
      tailMinTokens,
      tailMaxTokens,
      tailMinMessages,
      triggerFraction,
    });

    // --- Harness decides HOW to deliver context to the model ---

    // 1. Compaction check: ask the harness's own shouldCompact + compact
    // hooks. Default impls live below the class. Custom harnesses override.
    // compact() persists its product as a agent.thread_context_compacted
    // event with summary — derive() then sees the boundary and serves the
    // summarized view from this turn forward (NOT recomputed per turn).
    const allEvents = runtime.history.getEvents();
    if (runtime.sandbox) {
      await rebuildExternalizedToolResultsFromEvents(runtime.sandbox, allEvents);
    }
    const ctxWindow = resolveContextWindowTokens(model, { context_window_tokens: ctx.contextWindowTokens });
    if (this.shouldCompact && this.compact && this.shouldCompact(allEvents, { contextWindowTokens: ctxWindow })) {
      try {
        await this.compact(allEvents, runtime, {
          model,
          systemPrompt,
          tools,
          contextWindowTokens: ctx.contextWindowTokens,
        });
      } catch (err) {
        // Compaction is best-effort. Log and continue — the next turn will
        // try again. Don't fail the whole turn over a summarize error.
        console.warn(`[compact] failed: ${(err as Error).message}`);
      }
    }

    // 2. Derive ModelMessage[] from events. Default = eventsToMessagesAsync
    // (strict bijection inverse of write-side, with boundary handling +
    // async file_id → bytes resolution via ctx.fileFetcher). Custom harnesses
    // can override for sliding-window / RAG / etc. — the await unwraps either
    // sync or async overrides so existing implementations keep working.
    const messages = this.deriveModelContext
      ? await this.deriveModelContext(runtime.history.getEvents(), { fileFetcher: ctx.fileFetcher })
      : await eventsToMessagesAsync(runtime.history.getEvents(), ctx.fileFetcher);

    // 3. Apply provider-specific cache strategy. Anthropic: tag system block
    // + last tool + last message + (optional) one mid-conversation breakpoint
    // for long turns. Other providers: no-op (OpenAI prompt caching is
    // automatic; Google uses cachedContent; MiniMax TBD).
    //
    // AI SDK doesn't expose a provider-agnostic cache abstraction — each
    // provider exposes its own knobs via providerOptions. We branch on
    // model.provider here. To add OpenAI/Gemini cache support later, extend
    // the strategy table below; the harness loop above doesn't change.
    // 3. Apply provider-specific cache strategy.
    const cached = applyProviderCacheStrategy(model, systemPrompt, tools, messages);
    let finalMessages = cached.messages;

    // 4. Resolve model id
    const modelId = typeof agent.model === "string" ? agent.model : agent.model.id;

    // 5. Pre-flight token budgeting & Hard Guard check (SDS §5.5)
    const usableInputTokens = computeUsableInputTokens(ctxWindow);
    let estimatedTokens = estimateFullContextTokens({
      systemPrompt: cached.system,
      tools: cached.tools,
      messages: finalMessages,
    });

    if (estimatedTokens > usableInputTokens) {
      console.warn(
        `[pre-flight] Estimated tokens (${estimatedTokens}) exceed usable budget (${usableInputTokens}). Attempting emergency compaction...`,
      );
      if (this.compact) {
        try {
          await this.compact(runtime.history.getEvents(), runtime, { model, systemPrompt, tools });
          const refreshedEvents = runtime.history.getEvents();
          const refreshedMessages = this.deriveModelContext
            ? await this.deriveModelContext(refreshedEvents, { fileFetcher: ctx.fileFetcher })
            : await eventsToMessagesAsync(refreshedEvents, ctx.fileFetcher);
          const refreshedCached = applyProviderCacheStrategy(model, systemPrompt, tools, refreshedMessages);
          finalMessages = refreshedCached.messages;
          estimatedTokens = estimateFullContextTokens({
            systemPrompt: refreshedCached.system,
            tools: refreshedCached.tools,
            messages: finalMessages,
          });
        } catch (compactErr) {
          console.warn(`[pre-flight] Emergency compaction failed: ${(compactErr as Error).message}`);
        }
      }

      if (estimatedTokens > usableInputTokens) {
        const hardLimitErr = new ContextOverflowError(
          `Context projection exceeds model budget (${estimatedTokens} > ${usableInputTokens} tokens)`,
          {
            code: "context_projection_exceeds_budget",
            details: {
              provider: modelId,
              estimated_input_tokens: estimatedTokens,
              context_window_tokens: ctxWindow,
              usable_input_tokens: usableInputTokens,
            },
          },
        );
        throw hardLimitErr;
      }
    }

    // 6. Run agent loop with retry + single attempt 400 overflow fallback
    const runStreamAttempt = async (messagesToSend: ModelMessage[], attempt: number) => {
      let currentMessageId: string | null = null;
      const liveThinking = new Set<string>();
      const liveToolInput = new Set<string>();
      let stepStartId: string | null = null;
      let stepSawFirstChunk = false;
      let attemptSawFirstChunk = false;
      let attemptSawToolExecution = false;

      const streamStartedAt = Date.now();
      console.log(
        `[stream] streamText START attempt=${attempt} model=${modelId} messages=${messagesToSend.length} tools=${Object.keys(cached.tools ?? {}).length}`,
      );

      const llmLogCtx = ctx.env.llmLog;
      const wrappedModel: LanguageModel = llmLogCtx
        ? (wrapLanguageModel({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            model: model as any,
            middleware: llmLoggingMiddleware({
              tenant_id: llmLogCtx.tenant_id,
              session_id: llmLogCtx.session_id,
              r2: llmLogCtx.r2,
              spanIdResolver: () => stepStartId,
            }),
          }) as unknown as LanguageModel)
        : model;

      try {
        const r = streamText({
          model: wrappedModel,
          system:
            cached.system && (typeof cached.system !== "string" || cached.system.length > 0)
              ? cached.system
              : undefined,
          messages: messagesToSend,
          tools: cached.tools,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          prepareStep: ({ messages, stepNumber }) =>
            stepNumber === 0
              ? undefined
              : { messages: projectLargeToolResultsForProviderStep(messages) },
          stopWhen: stepCountIs(100),
          abortSignal: runtime.abortSignal,

          onChunk: ({ chunk }) => {
            if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
              if (!stepSawFirstChunk && stepStartId) {
                stepSawFirstChunk = true;
                attemptSawFirstChunk = true;
                runtime.broadcast({
                  type: "span.model_first_token",
                  model: modelId,
                  model_request_start_id: stepStartId,
                });
              }
            }

            if (chunk.type === "text-delta") {
              if (!currentMessageId) {
                currentMessageId = generateEventId();
                void runtime.broadcastStreamStart(currentMessageId);
              }
              void runtime.broadcastChunk(currentMessageId, chunk.text);
            } else if (chunk.type === "reasoning-delta") {
              const tid = (chunk as { id: string; text: string }).id;
              if (!liveThinking.has(tid)) {
                liveThinking.add(tid);
                void runtime.broadcastThinkingStart(tid);
              }
              void runtime.broadcastThinkingChunk(tid, (chunk as { text: string }).text);
            } else if (chunk.type === "tool-input-start") {
              const c = chunk as { id: string; toolName: string };
              attemptSawToolExecution = true;
              if (!liveToolInput.has(c.id)) {
                liveToolInput.add(c.id);
                void runtime.broadcastToolInputStart(c.id, c.toolName);
              }
            } else if (chunk.type === "tool-input-delta") {
              const c = chunk as { id: string; delta: string };
              attemptSawToolExecution = true;
              if (!liveToolInput.has(c.id)) {
                liveToolInput.add(c.id);
                void runtime.broadcastToolInputStart(c.id);
              }
              void runtime.broadcastToolInputChunk(c.id, c.delta);
            }
          },

          experimental_onStepStart: () => {
            stepStartId = generateEventId();
            stepSawFirstChunk = false;
            runtime.broadcast({
              type: "span.model_request_start",
              id: stepStartId,
              model: modelId,
            });
          },

          onStepFinish: async (step) => {
            for (const part of step.content as ReadonlyArray<ContentPart<any>>) {
              switch (part.type) {
                case "reasoning": {
                  const partWithId = part as {
                    type: "reasoning";
                    text: string;
                    id?: string;
                    providerMetadata?: unknown;
                  };
                  const tid =
                    partWithId.id ?? (liveThinking.size === 1 ? [...liveThinking][0] : undefined);
                  if (tid) {
                    await runtime.broadcastThinkingEnd(tid, "completed");
                    liveThinking.delete(tid);
                  }
                  runtime.broadcast({
                    type: "agent.thinking",
                    text: part.text,
                    providerOptions: part.providerMetadata as Record<string, unknown> | undefined,
                    ...(tid ? { thinking_id: tid } : {}),
                  } as SessionEvent);
                  break;
                }
                case "text": {
                  const messageId = currentMessageId ?? generateEventId();
                  if (currentMessageId) {
                    await runtime.broadcastStreamEnd(currentMessageId, "completed");
                  }
                  runtime.broadcast({
                    type: "agent.message",
                    message_id: messageId,
                    content: [{ type: "text", text: part.text.replace(/\s+$/, "") }],
                  } as SessionEvent);
                  currentMessageId = null;
                  break;
                }
                case "tool-call": {
                  attemptSawToolExecution = true;
                  const partTC = part as { type: "tool-call"; toolCallId: string };
                  if (liveToolInput.has(partTC.toolCallId)) {
                    await runtime.broadcastToolInputEnd(partTC.toolCallId, "completed");
                    liveToolInput.delete(partTC.toolCallId);
                  }
                  emitToolCallEvent(runtime, tools, part);
                  break;
                }
                case "tool-result":
                case "tool-error":
                  attemptSawToolExecution = true;
                  emitToolResultEvent(runtime, part);
                  break;
              }
            }

            for (const tid of liveThinking) {
              await runtime.broadcastThinkingEnd(tid, "aborted");
            }
            liveThinking.clear();
            for (const tid of liveToolInput) {
              await runtime.broadcastToolInputEnd(tid, "aborted");
            }
            liveToolInput.clear();

            const stepText = (step.content as ReadonlyArray<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
            const providerResponseId = (step.response as { id?: string } | undefined)?.id;
            const bodyR2Key = llmLogCtx
              ? llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId ?? "")
              : undefined;
            runtime.broadcast({
              type: "span.model_request_end",
              model: modelId,
              model_request_start_id: stepStartId ?? undefined,
              provider_response_id: providerResponseId,
              model_usage: step.usage
                ? {
                    input_tokens: step.usage.inputTokens ?? 0,
                    output_tokens: step.usage.outputTokens ?? 0,
                    cache_read_input_tokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
                    cache_creation_input_tokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
                  }
                : undefined,
              finish_reason: step.finishReason,
              final_text_length: stepText.length,
              is_error: false,
              ...(bodyR2Key ? { body_r2_key: bodyR2Key } : {}),
            });
            stepStartId = null;
          },

          onError: ({ error }) => {
            if (!stepStartId) return;
            let message = error instanceof Error ? error.message : String(error);
            if (error && typeof error === "object" && "responseBody" in error) {
              const e = error as { statusCode?: number; responseBody?: string };
              if (e.statusCode || e.responseBody) {
                message = `${message} [${e.statusCode ?? "?"}] ${e.responseBody ?? ""}`;
              }
            }
            const overflow = detectContextOverflowError(error);
            runtime.broadcast({
              type: "span.model_request_end",
              model: modelId,
              model_request_start_id: stepStartId,
              finish_reason: "error",
              final_text_length: 0,
              is_error: true,
              error_message: message.slice(0, 500),
              ...(overflow.isOverflow
                ? {
                    error_code: "provider_context_window_exceeded",
                    error_details: {
                      provider_status: overflow.statusCode,
                      provider_code: overflow.providerCode,
                      provider_message: overflow.providerMessage,
                      estimated_input_tokens: estimatedTokens,
                      context_window_tokens: ctxWindow,
                      attempt_id: attempt,
                    },
                  }
                : {}),
              ...(llmLogCtx
                ? { body_r2_key: llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId) }
                : {}),
            } as SessionEvent);
            stepStartId = null;
          },

          onAbort: () => {
            if (!stepStartId) return;
            runtime.broadcast({
              type: "span.model_request_end",
              model: modelId,
              model_request_start_id: stepStartId,
              finish_reason: "aborted",
              final_text_length: 0,
              is_error: false,
              ...(llmLogCtx
                ? { body_r2_key: llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId) }
                : {}),
            });
            stepStartId = null;
            if (currentMessageId) {
              void runtime.broadcastStreamEnd(currentMessageId, "aborted", "interrupted_mid_stream");
              currentMessageId = null;
            }
            for (const tid of liveThinking) {
              void runtime.broadcastThinkingEnd(tid, "aborted");
            }
            liveThinking.clear();
            for (const tid of liveToolInput) {
              void runtime.broadcastToolInputEnd(tid, "aborted");
            }
            liveToolInput.clear();
          },
        });

        try {
          await r.consumeStream();
        } catch (err) {
          if (currentMessageId) {
            await runtime.broadcastStreamEnd(currentMessageId, "aborted", "interrupted_mid_stream");
            currentMessageId = null;
          }
          for (const tid of liveThinking) {
            await runtime.broadcastThinkingEnd(tid, "aborted");
          }
          liveThinking.clear();
          for (const tid of liveToolInput) {
            await runtime.broadcastToolInputEnd(tid, "aborted");
          }
          liveToolInput.clear();
          throw err;
        }

        let streamError: unknown = null;
        for await (const part of r.fullStream) {
          if (part.type === "error") {
            streamError = part.error;
          }
        }

        if (streamError) {
          throw streamError;
        }

        const finishReason = await r.finishReason;
        const finalText = await r.text;
        const toolCalls = await r.toolCalls;
        const toolResults = await r.toolResults;
        const usage = await r.usage;

        if (
          (finishReason === "stop" || finishReason === "length") &&
          (!finalText || finalText.trim().length === 0) &&
          (!toolCalls || toolCalls.length === 0)
        ) {
          if (currentMessageId) {
            await runtime.broadcastStreamEnd(currentMessageId, "aborted", "silent_stop");
          }
          throw new ModelError(
            `silent_stop: model returned finish_reason=${finishReason} with empty text and no tool calls`,
          );
        }
        return { finishReason, text: finalText, toolCalls, toolResults, usage };
      } catch (err) {
        const overflow = detectContextOverflowError(err);
        if (overflow.isOverflow) {
          // Check single retry eligibility: attempt === 1, no tokens emitted, no side-effect tools started
          if (attempt === 1 && !attemptSawFirstChunk && !attemptSawToolExecution) {
            console.warn(
              `[context-overflow] Provider returned context overflow (code=${overflow.providerCode ?? "?"}) on attempt 1. Retrying once with emergency pruned context...`,
            );
            // Build emergency pruned context: keep leading summary if present + safe tail
            const emergencyMessages = buildEmergencyPrunedContext(messagesToSend);
            return await runStreamAttempt(emergencyMessages, 2);
          }

          // Not eligible or attempt 2 failed: raise structured ContextOverflowError
          throw new ContextOverflowError(
            overflow.providerMessage || "Model context window exceeded",
            {
              cause: err,
              code: "provider_context_window_exceeded",
              details: {
                provider: modelId,
                provider_status: overflow.statusCode ?? 400,
                provider_code: overflow.providerCode,
                provider_message: overflow.providerMessage,
                estimated_input_tokens: estimatedTokens,
                context_window_tokens: ctxWindow,
                attempt_id: attempt,
              },
            },
          );
        }
        throw classifyExternalError(err);
      } finally {
        const totalElapsed = Date.now() - streamStartedAt;
        console.log(`[stream] streamText END attempt=${attempt} elapsed=${totalElapsed}ms`);
      }
    };

    const result = await runStreamAttempt(finalMessages, 1);


    // 8. Detect pending tool confirmations and custom tool results
    if (result.toolCalls?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultedIds = new Set((result.toolResults as any[])?.map((r: any) => r.toolCallId) ?? []);
      const pending = result.toolCalls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => !resultedIds.has(c.toolCallId))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.toolCallId);
      if (pending.length && ctx.runtime.pendingConfirmations) {
        ctx.runtime.pendingConfirmations.push(...pending);
      }
    }

    // 9. Per-step model_request span pairs are emitted in onStepFinish above.
    //    The aggregate-around-streamText pair that used to live here was
    //    removed — Anthropic's wire format puts model_usage at per-call
    //    granularity, so we track it the same way. The session state still
    //    aggregates total token spend below via reportUsage(result.usage).

    // 10. Report token usage
    if (result.usage && runtime.reportUsage) {
      await runtime.reportUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0
      );
    }
  }

  // -- Default hook implementations --
  // Custom harnesses can override any of these by extending DefaultHarness
  // and replacing the method, or by implementing HarnessInterface directly.

  /**
   * Default: async eventsToMessagesAsync (byte-deterministic + handles
   * agent.thread_context_compacted boundary + resolves file_id sources via
   * the supplied fileFetcher). Override for sliding window / RAG /
   * hierarchical strategies.
   */
  deriveModelContext(
    events: SessionEvent[],
    opts?: { fileFetcher?: FileResolver },
  ): Promise<ModelMessage[]> {
    return eventsToMessagesAsync(events, opts?.fileFetcher);
  }

  /**
   * Default: delegate to this.compactionStrategy (configured in run() from
   * agent.metadata overrides). Custom harnesses can override by extending
   * DefaultHarness and replacing this method.
   */
  shouldCompact(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean {
    return this.compactionStrategy.shouldCompact(events, ctx);
  }

  /**
   * Default: run this.compactionStrategy.compact and broadcast the result
   * as an `agent.thread_context_compacted` event with the summary attached.
   * eventsToMessages then honors the boundary marker on subsequent derives.
   *
   * Threads systemPrompt + tools + the provider cache strategy through to
   * the strategy so it can build a same-shape request that matches main
   * agent's prefix bytes (cache reuse).
   */
  async compact(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: {
      model: LanguageModel;
      systemPrompt: string;
      tools: Record<string, any>;
      contextWindowTokens?: number;
    },
  ): Promise<void> {
    const ctxWindow = resolveContextWindowTokens(ctx.model, {
      context_window_tokens: ctx.contextWindowTokens,
    });
    const result = await this.compactionStrategy.compact(events, {
      model: ctx.model,
      contextWindowTokens: ctxWindow,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      applyCacheStrategy: (sys, tls, msgs) => applyProviderCacheStrategy(ctx.model, sys, tls, msgs),
      runtime,
    });
    if (!result) return;

    // Empty-summary defense (upstream layer). If a strategy returns a
    // result whose summary contains no actual text, do NOT broadcast the
    // boundary event. Otherwise eventsToMessages would later "honor" the
    // empty boundary and silently drop the entire pre-boundary history.
    //
    // Observed in the wild on MiniMax: model returns finish_reason="tool-calls"
    // with empty text → SummarizeCompactionStrategy returns
    // summary=[{type:"text", text:""}] → boundary written → next derive
    // tosses 60 turns of conversation. The new cc-style / opencode-style
    // strategies catch this themselves (return null) but the legacy
    // `summarize` strategy does not, so this layer is the safety net for
    // any strategy that doesn't self-defend.
    const hasContent = result.summary?.some(
      (b) => (b.type === "text" && b.text.trim().length > 0)
        || b.type === "image"
        || b.type === "document",
    );
    if (!hasContent) {
      console.warn("[compact] strategy produced empty summary — skipping boundary write");
      return;
    }

    runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
  }

  /**
   * No-op. Pre-2026-05-17 this wrote each `platformReminder` as a
   * `<system-reminder>` user.message event so Claude would treat the
   * skill body as user-side context. Operators objected: skill bodies
   * leaked into the visible chat feed and polluted the event log even
   * though the content is static per session.
   *
   * Reminders now flow into the system prompt directly — see
   * `composeSystemPrompt(rawSystemPrompt, platformReminders)` in
   * `session-do.ts`. Each reminder is wrapped in
   * `<source name="…">…</source>` inside the system prompt, so the
   * model still has structural cues about which skill/memory each
   * chunk came from.
   *
   * Custom harnesses that DO want the legacy behavior (e.g. a RAG
   * loop that materializes skills only after retrieving them) can
   * override this method and broadcast their own user.message events.
   */
  async onSessionInit(_ctx: HarnessContext, _runtime: HarnessRuntime): Promise<void> {
    // intentionally empty — see jsdoc
  }
}

// === Token estimation + context-window resolution ===
export { estimateMessageTokens, estimateMessagesTokens } from "./token-estimator";
export { resolveContextWindowTokens } from "./context-window";

/**
 * Project large tool outputs only for the provider request assembled between
 * streamText steps. The recorded StepResult remains untouched, so
 * onStepFinish can still persist the full raw output in the durable event log.
 */
export function projectLargeToolResultsForProviderStep(
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const rawContent = normalizeToolOutputForWire((part as any).output);
      const projected = projectToolResultForModel(
        rawContent,
        (part as any).toolCallId,
        (part as any).toolName,
      );
      if (!projected.isExternalized) return part;
      changed = true;
      return {
        ...part,
        output: { type: "text", value: projected.output },
      };
    });

    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
}

export function buildEmergencyPrunedContext(messagesToSend: ModelMessage[]): ModelMessage[] {
  if (messagesToSend.length === 0) return [];

  const isSummaryMessage = (m: ModelMessage): boolean => {
    if (m.role !== "user") return false;
    if (typeof m.content === "string") {
      return m.content.includes("<conversation-summary>");
    }
    if (Array.isArray(m.content)) {
      return m.content.some(
        (part: any) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes("<conversation-summary>"),
      );
    }
    return false;
  };

  const summaryIndex = messagesToSend.findIndex(isSummaryMessage);
  const summaryMsg = summaryIndex >= 0 ? messagesToSend[summaryIndex] : null;

  // Build index maps:
  // 1. toolCallId -> assistant message index that made the call
  // 2. toolCallId -> array of tool message indexes containing its results
  const toolCallToAssistant = new Map<string, number>();
  const toolCallToResults = new Map<string, number[]>();

  for (let i = 0; i < messagesToSend.length; i++) {
    const m = messagesToSend[i];
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if ((part as any).type === "tool-call" && (part as any).toolCallId) {
          toolCallToAssistant.set((part as any).toolCallId, i);
        }
      }
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if ((part as any).type === "tool-result" && (part as any).toolCallId) {
          const tid = (part as any).toolCallId;
          const list = toolCallToResults.get(tid) ?? [];
          list.push(i);
          toolCallToResults.set(tid, list);
        }
      }
    }
  }

  // Start with at least the last 2 messages (excluding leading summary if we prepend it later)
  let startIndex = Math.max(0, messagesToSend.length - 2);

  // Expand startIndex backwards until all tool-call and tool-result pairs in [startIndex, end] are complete
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let i = startIndex; i < messagesToSend.length; i++) {
      const m = messagesToSend[i];
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if ((part as any).type === "tool-result" && (part as any).toolCallId) {
            const astIdx = toolCallToAssistant.get((part as any).toolCallId);
            if (astIdx !== undefined && astIdx < startIndex) {
              startIndex = astIdx;
              expanded = true;
            }
          }
        }
      } else if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if ((part as any).type === "tool-call" && (part as any).toolCallId) {
            const resIndices = toolCallToResults.get((part as any).toolCallId);
            if (resIndices) {
              for (const rIdx of resIndices) {
                if (rIdx < startIndex) {
                  startIndex = rIdx;
                  expanded = true;
                }
              }
            }
          }
        }
      }
    }
  }

  const tailSlice: ModelMessage[] = [];
  for (let i = startIndex; i < messagesToSend.length; i++) {
    if (i === summaryIndex) continue;
    tailSlice.push(messagesToSend[i]);
  }

  if (summaryMsg) {
    return [summaryMsg, ...tailSlice];
  }
  return tailSlice;
}

// === Provider-specific prompt cache strategy ===
//
// AI SDK has no provider-agnostic cache abstraction. Each provider exposes
// its own knobs via providerOptions, so we branch on model.provider:
//   anthropic: cache_control breakpoints on system / last tool / mid / last msg
//   openai:    automatic on the API side (no client-side knob to set)
//   google:    cachedContent (different model — explicit cache resource creation)
//   others:    no-op
//
// Adding a provider later: add a case below; the calling harness code
// doesn't change.

interface CacheStrategyResult {
  system: string | SystemModelMessage | SystemModelMessage[];
  tools: Record<string, any>;
  messages: ModelMessage[];
}

function applyProviderCacheStrategy(
  model: LanguageModel,
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const provider = (model as any)?.provider as string | undefined;
  if (typeof provider === "string" && provider.toLowerCase().includes("anthropic")) {
    return applyAnthropicCacheControl(systemPrompt, tools, messages);
  }
  // No-op for other providers — system stays a string, no providerOptions
  // injected, no message mutation. Add cases here when wiring OpenAI /
  // Gemini / MiniMax cache support.
  return { system: systemPrompt, tools, messages };
}

/**
 * Anthropic prompt-cache strategy — up to 4 breakpoints per request.
 *
 * Render order is tools → system → messages. Marks (in priority order):
 *  1. `system` — promote string → SystemModelMessage with cacheControl.
 *     Caches both `tools` (everything before system in the prefix) and
 *     `system` itself.
 *  2. last `tool` — covers the tool block alone if system also contained
 *     dynamic content (defensive — system change shouldn't shift tools).
 *  3. last `message` — the conversation tail breakpoint. Most cache hits
 *     come from this on multi-turn chats.
 *  4. mid-conversation `message` — only if messages.length > 30. Anthropic's
 *     20-block lookback window means long single turns blow past the
 *     boundary; an intermediate breakpoint catches reads inside the turn.
 *
 * All marker bytes are stable (cacheControl object is identical across
 * turns), so adding them doesn't itself bust cache.
 */
function applyAnthropicCacheControl(
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } };

  // (1) System block as cached SystemModelMessage. Required for system to
  // cache at all — string-form `system` is wrapped by the provider with no
  // providerOptions, which means cache_control is omitted on the wire.
  //
  // Skip the cache_control wrapper when systemPrompt is empty: Anthropic's
  // API rejects `cache_control` on empty text blocks ("system.0:
  // cache_control cannot be set for empty text blocks"), and an empty
  // system isn't worth caching anyway. Pass the empty string through —
  // the SDK omits the system block entirely when given an empty string,
  // which is the desired wire shape.
  const system: SystemModelMessage | string = systemPrompt
    ? { role: "system", content: systemPrompt, providerOptions: ephemeral }
    : systemPrompt;

  // (2) Tools: tag the LAST tool's providerOptions so the entire tools
  // block becomes a 2nd cache breakpoint.
  const toolNames = Object.keys(tools);
  let cachedTools: Record<string, any> = tools;
  if (toolNames.length > 0) {
    const lastName = toolNames[toolNames.length - 1];
    const lastTool = tools[lastName];
    cachedTools = {
      ...tools,
      [lastName]: {
        ...lastTool,
        providerOptions: { ...(lastTool?.providerOptions ?? {}), ...ephemeral },
      },
    };
  }

  // (3) Last 1 message — Claude Code style.
  const cachedMessages: ModelMessage[] = messages.map((m) => ({ ...m }));
  if (cachedMessages.length > 0) {
    const last = cachedMessages[cachedMessages.length - 1] as any;
    last.providerOptions = { ...(last.providerOptions ?? {}), ...ephemeral };
  }

  return { system, tools: cachedTools, messages: cachedMessages };
}
