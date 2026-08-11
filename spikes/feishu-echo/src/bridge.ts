import type { OmaClient } from "./oma.js";
import type { Logger } from "./logger.js";

export interface ReplyBridge {
  reply(userText: string): Promise<string>;
}

export function createEchoBridge(): ReplyBridge {
  return {
    async reply(userText: string): Promise<string> {
      return `echo: ${userText}`;
    },
  };
}

export function createOmaBridge(opts: {
  client: OmaClient;
  sessionId: string;
  logger: Logger;
}): ReplyBridge {
  const { client, sessionId, logger } = opts;
  return {
    async reply(userText: string): Promise<string> {
      const res = await client.reply(sessionId, userText);
      if (!res.text) {
        logger.warn({ op: "bridge.empty", frames: res.frames }, "empty agent reply");
        return "(agent returned no text)";
      }
      return res.text;
    },
  };
}
