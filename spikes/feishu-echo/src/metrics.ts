// Per-turn latency tracker. The spike reports total (received→sent), bridge
// (oma_start→oma_done), and send (oma_done→sent) so we get a baseline for the
// PRD's 120s conclusion SLA and see where the time actually goes.

export type Phase = "received" | "bridge_start" | "bridge_done" | "sent";

export interface LatencyReport {
  messageId: string;
  totalMs: number;
  bridgeMs: number;
  sendMs: number;
  ok: boolean;
}

export class TurnMetrics {
  private readonly marks = new Map<Phase, number>();
  constructor(private readonly messageId: string) {}

  mark(phase: Phase): void {
    if (!this.marks.has(phase)) this.marks.set(phase, Date.now());
  }

  report(opts: { ok: boolean }): LatencyReport {
    const m = this.marks;
    const received = m.get("received") ?? 0;
    const bridgeStart = m.get("bridge_start") ?? received;
    const bridgeDone = m.get("bridge_done") ?? bridgeStart;
    const sent = m.get("sent") ?? bridgeDone;
    return {
      messageId: this.messageId,
      totalMs: sent - received,
      bridgeMs: bridgeDone - bridgeStart,
      sendMs: sent - bridgeDone,
      ok: opts.ok,
    };
  }
}
