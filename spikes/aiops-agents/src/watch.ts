// Watch mode — the Feishu path.
//
// main-node's WS runner owns the Feishu App connection and routes inbound
// group messages into the supervisor agent's chat-scoped sessions (the first
// supervisor reply is mirrored back automatically by the one-shot egress
// writer). This loop polls the supervisor's sessions over REST; whenever a
// turn ends with an unhandled aiops-dispatch block, it runs the expert rounds
// and continues the session. The supervisor's FINAL turn reaches the group
// via its own mcp__feishu__im_message_send tool (chat_id from the signal
// envelope) — later turns are not auto-mirrored, by design one-shot egress.

import { createHash } from "node:crypto";

import type { Config } from "./env.js";
import { OmaClient, eventText } from "./oma.js";
import { Orchestrator } from "./orchestrator.js";
import { extractDispatch } from "./protocol.js";

export interface WatchDeps {
  oma: OmaClient;
  config: Config;
  supervisorAgentId: string;
  orchestrator: Orchestrator;
  log?: (line: string) => void;
}

export function startWatcher(deps: WatchDeps): { stop: () => void } {
  const { oma, config, supervisorAgentId, orchestrator } = deps;
  const log = deps.log ?? ((line: string) => console.log(`[watch] ${line}`));

  /** dispatch-block fingerprints already orchestrated (survives within process). */
  const handled = new Set<string>();
  /** sessions with an orchestration currently in flight. */
  const inFlight = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const sessions = await oma.listSessions(supervisorAgentId);
      for (const session of sessions) {
        if (stopped) break;
        // A dispatch block only exists once the turn ended → session idle.
        if (session.status && session.status !== "idle") continue;
        if (inFlight.has(session.id)) continue;

        const events = await oma.getEvents(session.id);
        const lastAgentMessage = [...events].reverse().find((e) => e.type === "agent.message");
        if (!lastAgentMessage) continue;
        const text = eventText(lastAgentMessage);
        if (!text) continue;
        if (!extractDispatch(text)) continue;

        const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);
        if (handled.has(fingerprint)) continue;
        handled.add(fingerprint);
        inFlight.add(session.id);

        log(`dispatch detected in ${session.id}${session.title ? ` (${session.title})` : ""} — orchestrating`);
        // Detached: one slow discussion must not stall the poll loop.
        void orchestrator
          .continueFrom(session.id, text, `watch-${fingerprint}`)
          .then((result) => {
            log(`discussion concluded in ${session.id}; conclusion ${result.conclusion.length} chars`);
          })
          .catch((err: unknown) => {
            log(`discussion failed in ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => inFlight.delete(session.id));
      }
    } catch (err) {
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopped) timer = setTimeout(tick, config.watchPollMs);
  };

  log(`polling ${config.omaBase} every ${config.watchPollMs}ms for supervisor dispatches…`);
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
