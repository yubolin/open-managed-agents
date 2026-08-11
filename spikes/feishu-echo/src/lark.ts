import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "./logger.js";

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  text: string;
  raw: unknown;
}

export interface FeishuHandler {
  onMessage(msg: IncomingMessage): Promise<void>;
}

export interface FeishuClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
}

interface FeishuOptions {
  appId: string;
  appSecret: string;
  handler: FeishuHandler;
  logger: Logger;
}

// Our narrow view of the SDK payload. The real shape is wider; we deliberately
// treat SDK data as untrusted and narrow via `as unknown as` (see handler).
interface LarkReceivePayload {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: unknown;
  };
}

function extractText(messageType: string, contentRaw: unknown): string {
  if (messageType !== "text") return "";
  if (typeof contentRaw !== "string") return "";
  let parsed: { text?: unknown } = {};
  try {
    parsed = JSON.parse(contentRaw) as { text?: unknown };
  } catch {
    return "";
  }
  const text = typeof parsed.text === "string" ? parsed.text : "";
  // Strip @-mention placeholders (e.g. "@_user_1 ") — the bot itself is a
  // frequent mention target and we only want the user's actual question.
  return text.replace(/@_user_\d+\s*/g, "").trim();
}

export function createFeishuClient(opts: FeishuOptions): FeishuClient {
  const { appId, appSecret, handler, logger } = opts;

  const client = new lark.Client({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        const d = data as unknown as LarkReceivePayload;
        const message = d.message ?? {};
        const messageId = message.message_id ?? "";
        const chatId = message.chat_id ?? "";
        if (!messageId || !chatId) return;
        const text = extractText(message.message_type ?? "", message.content);
        if (!text) return; // spike: text messages only
        await handler.onMessage({
          messageId,
          chatId,
          chatType: message.chat_type ?? "p2p",
          senderId: d.sender?.sender_id?.open_id ?? "unknown",
          text,
          raw: data,
        });
      } catch (err) {
        logger.error(
          { op: "feishu.on_message.failed", err: String(err) },
          "im.message.receive_v1 handler failed",
        );
      }
    },
  });

  let wsClient: lark.WSClient | null = null;

  return {
    async start(): Promise<void> {
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.warn,
      });
      await wsClient.start({ eventDispatcher });
      logger.info({ op: "feishu.ws.connected", appId }, "Feishu WebSocket connected");
    },
    async stop(): Promise<void> {
      // The SDK has no public graceful stop in many versions; best-effort log.
      logger.info({ op: "feishu.ws.stop" }, "Feishu WS stop requested");
      wsClient = null;
    },
    async sendText(chatId: string, text: string): Promise<void> {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    },
  };
}
