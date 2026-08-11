import { loadEnv } from "./env.js";
import { createLogger, errToString } from "./logger.js";
import { createMessageDeduper } from "./dedup.js";
import { TurnMetrics } from "./metrics.js";
import { createOmaClient } from "./oma.js";
import { createEchoBridge, createOmaBridge, type ReplyBridge } from "./bridge.js";
import { createFeishuClient, type FeishuClient, type FeishuHandler, type IncomingMessage } from "./lark.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const dedup = createMessageDeduper();

  const bridge: ReplyBridge =
    env.MODE === "oma"
      ? createOmaBridge({
          client: createOmaClient({
            baseUrl: env.OMA_BASE_URL,
            apiKey: env.OMA_API_KEY,
            logger,
          }),
          sessionId: env.OMA_SESSION_ID,
          logger,
        })
      : createEchoBridge();

  logger.info(
    {
      op: "spike.start",
      mode: env.MODE,
      base: env.OMA_BASE_URL,
      session: env.OMA_SESSION_ID,
    },
    "feishu-echo spike starting",
  );

  // `feishu` is referenced inside the handler closure and only invoked after
  // start(), so declaring it after the handler is safe.
  const handler: FeishuHandler = {
    async onMessage(msg: IncomingMessage): Promise<void> {
      if (dedup.seen(msg.messageId)) {
        logger.debug({ op: "dedup.skip", messageId: msg.messageId }, "duplicate event skipped");
        return;
      }
      const metrics = new TurnMetrics(msg.messageId);
      metrics.mark("received");
      try {
        metrics.mark("bridge_start");
        const replyText = await bridge.reply(msg.text);
        metrics.mark("bridge_done");
        await feishu.sendText(msg.chatId, replyText);
        metrics.mark("sent");
        logger.info(
          {
            op: "turn.ok",
            chatId: msg.chatId,
            chatType: msg.chatType,
            senderId: msg.senderId,
            ...metrics.report({ ok: true }),
            replyChars: replyText.length,
          },
          "turn completed",
        );
      } catch (err) {
        logger.error(
          {
            op: "turn.failed",
            chatId: msg.chatId,
            ...metrics.report({ ok: false }),
            err: errToString(err),
          },
          "turn failed",
        );
      }
    },
  };

  const feishu: FeishuClient = createFeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    handler,
    logger,
  });

  await feishu.start();

  const shutdown = (signal: string): void => {
    logger.info({ op: "spike.shutdown", signal }, "received signal, exiting");
    void feishu.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stdout.write(
    JSON.stringify({ level: "error", op: "spike.fatal", err: errToString(err) }) + "\n",
  );
  process.exit(1);
});
