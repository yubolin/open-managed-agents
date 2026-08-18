// Base E · Approval Timeout Scheduler — Node interval driver (run-model
// spec §6.3 裁决 5, template spec §3.2).
//
// The scan-and-act logic lives in @open-managed-agents/operations-store
// (runOperationsTimeoutTick) and is shared verbatim with the CF Cron Trigger
// registration in apps/main/src/lib/cf-scheduler-jobs.ts — both dialects run
// the SAME tick; only the firing mechanism differs. This file owns the
// Node-isms: setInterval pacing, unref, and the in-flight guard that keeps
// interval ticks serial.
//
// There is NO auto-approve path — 裁决 5 is a system invariant, not a
// configuration. See timeout-tick.ts for the semantics header.

import { getLogger } from "@open-managed-agents/observability";
import {
  runOperationsTimeoutTick,
  SYSTEM_TIMEOUT_ACTOR,
  type AuditActor,
  type OperationsService,
  type SendEscalationCard,
  type TimeoutTickOptions,
  type TimeoutTickStats,
} from "@open-managed-agents/operations-store";

export { SYSTEM_TIMEOUT_ACTOR };
export type { TimeoutTickStats };

const log = getLogger("operations-timeout-scheduler");

export interface TimeoutSchedulerOptions {
  service: OperationsService;
  /** Egress for escalation cards (injected: FeishuApiClient.sendCard in prod). */
  sendCard: SendEscalationCard;
  /** Wall clock; default Date.now. */
  nowMs?: () => number;
  /** Tick interval; default 60s. */
  intervalMs?: number;
  /** Workspace deep-link base for card buttons; default http://localhost:5175. */
  workspaceBaseUrl?: string;
  /** Optional SSE bridge — fanned on every escalation action. */
  onEvent?: TimeoutTickOptions["onEvent"];
}

export interface TimeoutSchedulerHandle {
  /** One scan-and-act pass. Serial: the interval loop never overlaps ticks. */
  tick(): Promise<TimeoutTickStats>;
  stop(): Promise<void>;
}

export function startOperationsTimeoutScheduler(
  opts: TimeoutSchedulerOptions,
): TimeoutSchedulerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let stopped = false;

  const handle: TimeoutSchedulerHandle = {
    tick: async () => {
      if (inFlight) {
        // Interval loop guard — manual tick() during an in-flight tick is a no-op.
        return { scanned: 0, notified: 0, cancelled: 0, skipped: 0, errors: 0 };
      }
      inFlight = true;
      try {
        return await runOperationsTimeoutTick(opts);
      } finally {
        inFlight = false;
      }
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  timer = setInterval(() => {
    if (stopped) return;
    void handle.tick().catch((err) => {
      log.error({ op: "timeout_scheduler.tick_failed", err }, "timeout scheduler tick failed");
    });
  }, intervalMs);
  // Node default: the interval must not hold the process open in tests.
  timer.unref?.();

  return handle;
}

// Re-exported for existing deep-import consumers; the card builder is part
// of the shared tick surface now.
export { buildEscalationCard } from "@open-managed-agents/operations-store";

// Keep the AuditActor shape referenced so the re-export above stays a
// source-level superset of the pre-extraction module surface.
export type { AuditActor };
