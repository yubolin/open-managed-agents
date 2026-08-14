// aiopsDispatchTick — cron job factory for the alert→triage-session sweeper.
//
// Modeled on packages/scheduler/src/jobs/linear-dispatch.ts but kept inside
// the aiops package so the upstream scheduler package stays untouched
// (upgrade-isolation rule in docs/aiops-closed-loop.md). One factory, two
// hosts: registered by the Node scheduler wiring via the generic
// `extraJobs` hook; a CF `scheduled()` host can reuse it verbatim later.
//
// Flow per tick: claimNew (statement-atomic, multi-replica safe) → for each
// claimed alert the host-provided sweeper routes it (new triage session, or
// resume of the open session for that fingerprint) → attachSession /
// attachError. Per-alert failures are isolated; one bad alert never kills
// the tick.

import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("aiops.dispatch");

export interface AiopsDispatchTickResult {
  claimed: number;
  dispatched: number;
  /** Occurrences/resumes folded into an existing open triage session. */
  resumed: number;
  failed: number;
  errors: ReadonlyArray<{ alertId: string; message: string }>;
}

export interface AiopsDispatchSweeper {
  runDispatchTick(nowMs: number, alertLimit: number): Promise<AiopsDispatchTickResult>;
}

export interface AiopsDispatchTickDeps {
  /** Lazy per-tick sweeper resolution (host may need to resolve the triage
   *  agent first). Null skips the tick silently — mirrors linearSweeper. */
  resolveSweeper: () => Promise<AiopsDispatchSweeper | null>;
  /** Cap claimed alerts per tick. Default 20. */
  alertLimit?: number;
}

export function aiopsDispatchTick(deps: AiopsDispatchTickDeps): () => Promise<void> {
  const alertLimit = deps.alertLimit ?? 20;
  return async () => {
    const startedAt = Date.now();
    let sweeper: AiopsDispatchSweeper | null;
    try {
      sweeper = await deps.resolveSweeper();
    } catch (err) {
      log.warn({ err, op: "aiops_dispatch.resolve_failed" }, "sweeper resolve failed");
      return;
    }
    if (!sweeper) return;
    try {
      const res = await sweeper.runDispatchTick(startedAt, alertLimit);
      log.info(
        {
          op: "aiops_dispatch.tick",
          claimed: res.claimed,
          dispatched: res.dispatched,
          resumed: res.resumed,
          failed: res.failed,
          dur_ms: Date.now() - startedAt,
        },
        "aiops dispatch tick complete",
      );
      for (const e of res.errors) {
        log.warn(
          { op: "aiops_dispatch.alert_error", alert_id: e.alertId, err: e.message },
          e.message,
        );
      }
    } catch (err) {
      log.error({ err, op: "aiops_dispatch.fatal" }, "aiops dispatch tick failed");
    }
  };
}
