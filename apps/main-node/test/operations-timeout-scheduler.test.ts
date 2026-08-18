// Base E · approval timeout scheduler integration tests.
//
// Semantics under test (run-model spec §6.3 裁决 5 + template spec §3.2):
//   - due escalation_actions fire once (run_events dedup, one chance per
//     action — anti-spam survives crashes between send and record);
//   - notify_feishu_group sends an interactive card via injected egress;
//   - mark_approval_overdue_and_cancel cancels via the SAME CAS path as a
//     human cancel (matrix row 3) with cancel_reason=approval_timeout and a
//     run.cancel audit — NEVER an auto-approve (system invariant);
//   - races with a concurrent approval decision are swallowed (CAS conflict
//     = the human won, which is always the correct outcome);
//   - bad timeout_policy JSON skips the run without crashing the tick.
//
// updated_at is the timeout anchor: finishPlanning / stage-advance CAS both
// refresh it, so a reworked or stage-advanced run restarts its clock.

import { describe, expect, it, beforeEach } from "vitest";
import {
  InMemoryOperationsStore,
  OperationsService,
  type AuditActor,
  type ServiceTemplateRow,
  type ServiceTemplateVersionRow,
} from "@open-managed-agents/operations-store";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";
import {
  startOperationsTimeoutScheduler,
  SYSTEM_TIMEOUT_ACTOR,
} from "../src/lib/operations-timeout-scheduler";

describe("Base E · approval timeout scheduler", () => {
  let store: InMemoryOperationsStore;
  let service: OperationsService;
  let sentCards: Array<{ chatId: string; card: any }>;
  // Real service-hub path (run.cancelled etc.) recorded via a capture hub.
  let hubEvents: WorkspaceStreamEvent[];
  // Scheduler bridge frames (run.escalation).
  let sseEvents: Array<{ tenantId: string; runId: string; type: string; payload: any }>;
  let now: number;

  const tenantA = "tenant_alpha";
  const actorAlice: AuditActor = { type: "user", id: "user_alice", name: "Alice (Applicant)" };
  const actorBob: AuditActor = { type: "user", id: "user_bob", name: "Bob (Approver)" };

  beforeEach(() => {
    store = new InMemoryOperationsStore();
    hubEvents = [];
    service = new OperationsService(store, {
      publish: (_t, _r, event) => {
        hubEvents.push(event);
      },
      subscribe: () => () => {},
    });
    sentCards = [];
    sseEvents = [];
    now = Date.now();
  });

  function makeScheduler() {
    return startOperationsTimeoutScheduler({
      service,
      sendCard: async (chatId, card) => {
        sentCards.push({ chatId, card });
      },
      nowMs: () => now,
      intervalMs: 60_000,
      workspaceBaseUrl: "http://ops.test",
      onEvent: (tenantId, runId, type, payload) => {
        sseEvents.push({ tenantId, runId, type, payload });
      },
    });
  }

  /** Seed a template with the given timeout_policy and walk a run to awaiting_approval. */
  async function seedAwaitingRun(
    timeoutPolicy: unknown,
    opts: { approvalStages?: number } = {},
  ): Promise<string> {
    const stages = opts.approvalStages ?? 1;
    const template: ServiceTemplateRow = {
      id: "stpl_e",
      tenant_id: tenantA,
      name: "E Template",
      code: "e_tpl",
      category: "diagnosis",
      description: "",
      is_active: 1,
      current_version_id: "stplv_e1",
      created_by: "system",
      created_at: now,
      updated_at: now,
    };
    const version: ServiceTemplateVersionRow = {
      id: "stplv_e1",
      template_id: "stpl_e",
      tenant_id: tenantA,
      version: 1,
      is_active: 1,
      agent_binding: JSON.stringify({ agent_id: "agent_x", version: 1 }),
      form_schema: JSON.stringify({ type: "object" }),
      ui_schema: null,
      approval_policy: JSON.stringify({
        mode: "sequential_groups",
        stages: Array.from({ length: stages }, (_, i) => ({
          stage_order: i + 1,
          stage_name: `Stage ${i + 1}`,
          group_id: `grp_${i + 1}`,
          required_approvals: 1,
        })),
      }),
      timeout_policy:
        typeof timeoutPolicy === "string" ? timeoutPolicy : JSON.stringify(timeoutPolicy),
      changelog: null,
      published_by: "system",
      published_at: now,
    };
    await store.insertTemplate(template, version);

    const run = await service.createRun({
      tenantId: tenantA,
      templateId: "stpl_e",
      title: "E Run",
      inputParameters: {},
      actor: actorAlice,
      autoSubmit: true,
    });
    await service.startPlanning(tenantA, run.id, "sess_e", actorAlice);
    await service.finishPlanning(
      tenantA,
      run.id,
      { content: "plan", sha256: "sha_p" },
      { id: "art_ev", content: "evidence", sha256: "sha_e" },
      actorAlice,
    );
    return run.id;
  }

  it("1. Due notify_feishu_group sends one interactive card + records dedup event + SSE frame", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 60,
      escalation_interval_minutes: 15,
      escalation_actions: [
        { at_minute: 15, action: "notify_feishu_group", target: "oc_sre_duty" },
      ],
    });

    now += 16 * 60_000; // 16 min elapsed > 15 min threshold
    const sched = makeScheduler();
    const stats = await sched.tick();

    expect(stats.scanned).toBe(1);
    expect(stats.notified).toBe(1);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]!.chatId).toBe("oc_sre_duty");
    // Card carries run identity + workspace deep link
    const cardJson = JSON.stringify(sentCards[0]!.card);
    expect(cardJson).toContain(runId);
    expect(cardJson).toContain("http://ops.test/runs/" + runId);

    // Dedup marker persisted with the stable key
    const events = await service.listEvents(tenantA, runId, 500);
    const markers = events.filter((e) => e.action === "run.escalation");
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]!.payload!)).toMatchObject({
      dedup_key: "notify_feishu_group:15",
    });

    // SSE bridge fanned the escalation frame
    expect(sseEvents).toContainEqual(
      expect.objectContaining({ runId, type: "run.escalation" }),
    );
  });

  it("2. Re-ticking does NOT re-send (one chance per action, anti-spam)", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 60,
      escalation_actions: [
        { at_minute: 15, action: "notify_feishu_group", target: "oc_sre_duty" },
      ],
    });

    now += 16 * 60_000;
    const sched = makeScheduler();
    await sched.tick();
    now += 30 * 60_000; // well past the threshold again
    const stats2 = await sched.tick();

    expect(sentCards).toHaveLength(1);
    expect(stats2.notified).toBe(0);
  });

  it("3. mark_approval_overdue_and_cancel cancels via CAS row 3 with audit, reason and SSE — never approves", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 30,
      escalation_actions: [
        { at_minute: 30, action: "mark_approval_overdue_and_cancel", final_state_behavior: "cancelled" },
      ],
    });

    now += 31 * 60_000;
    const sched = makeScheduler();
    const stats = await sched.tick();

    expect(stats.cancelled).toBe(1);

    const run = await service.getRun(tenantA, runId);
    expect(run.state).toBe("cancelled"); // 裁决 5: cancelled, NEVER approved
    expect(JSON.parse(run.failure_reason!)).toEqual({ cancel_reason: "approval_timeout" });

    const events = await service.listEvents(tenantA, runId, 500);
    const cancelAudit = events.find((e) => e.action === "run.cancel");
    expect(cancelAudit).toBeDefined();
    expect(JSON.parse(cancelAudit!.actor!)).toMatchObject({ id: SYSTEM_TIMEOUT_ACTOR.id });
    expect(JSON.parse(cancelAudit!.payload!)).toEqual({ cancel_reason: "approval_timeout" });

    expect(sseEvents).toContainEqual(expect.objectContaining({ type: "run.escalation" }));
    // run.cancelled travels the REAL service hub path (same as human cancel)
    expect(hubEvents.some((e) => e.event_type === "run.cancelled")).toBe(true);
    // Cancelled runs leave the scan set
    const stats2 = await sched.tick();
    expect(stats2.scanned).toBe(0);
  });

  it("4. Race: run decided between scan and action → CAS conflict swallowed, no crash, run keeps human decision", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 30,
      escalation_actions: [
        { at_minute: 30, action: "mark_approval_overdue_and_cancel" },
      ],
    });

    // Human approves BEFORE the tick fires (run leaves awaiting_approval)
    await service.decideApproval({
      tenantId: tenantA,
      runId,
      actor: actorBob,
      decision: "approved",
    });

    now += 31 * 60_000;
    const sched = makeScheduler();
    const stats = await sched.tick();

    expect(stats.cancelled).toBe(0);
    const run = await service.getRun(tenantA, runId);
    expect(run.state).toBe("approved"); // human decision preserved
  });

  it("5. No cancel action configured → run may sit past timeout forever WITHOUT auto-approve (invariant even without cancel)", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 30,
      escalation_actions: [
        { at_minute: 30, action: "notify_feishu_group", target: "oc_x" },
      ],
    });

    now += 10 * 24 * 60_000; // ten days
    const sched = makeScheduler();
    await sched.tick();

    const run = await service.getRun(tenantA, runId);
    expect(run.state).toBe("awaiting_approval");
    expect(sentCards).toHaveLength(1);
  });

  it("6. Bad timeout_policy JSON → run skipped, tick survives, no card no event", async () => {
    await seedAwaitingRun("{broken json");

    now += 60 * 60_000;
    const sched = makeScheduler();
    const stats = await sched.tick();

    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(sentCards).toHaveLength(0);
  });

  it("7. notify_process_owner records audit but does not fake a delivery (P0: no user↔open_id directory, debt F7)", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 60,
      escalation_actions: [
        { at_minute: 15, action: "notify_process_owner", channel: "feishu_direct_message" },
      ],
    });

    now += 20 * 60_000;
    const sched = makeScheduler();
    await sched.tick();

    expect(sentCards).toHaveLength(0); // no fabricated delivery
    const events = await service.listEvents(tenantA, runId, 500);
    const marker = events.find((e) => e.action === "run.escalation");
    expect(marker).toBeDefined();
    expect(JSON.parse(marker!.payload!)).toMatchObject({
      dedup_key: "notify_process_owner:15",
      delivered: false,
    });
  });

  it("8. Stage advance refreshes the clock anchor (updated_at) — escalation does not re-fire for the new stage (per-run dedup, documented P0)", async () => {
    const runId = await seedAwaitingRun(
      {
        approval_timeout_minutes: 120,
        escalation_actions: [
          { at_minute: 15, action: "notify_feishu_group", target: "oc_sre" },
        ],
      },
      { approvalStages: 2 },
    );

    // Fire the reminder at stage 1
    now += 16 * 60_000;
    const sched = makeScheduler();
    await sched.tick();
    expect(sentCards).toHaveLength(1);

    // Stage 1 approved → stage 2 awaiting (updated_at refreshed to now)
    await service.decideApproval({
      tenantId: tenantA,
      runId,
      actor: actorBob,
      decision: "approved",
    });
    const run = await service.getRun(tenantA, runId);
    expect(run.state).toBe("awaiting_approval");
    expect(run.current_approval_stage).toBe(2);

    // Stage 2 sits 16 min — the 15-min reminder does NOT re-fire (P0 per-run dedup)
    now += 16 * 60_000;
    const stats = await sched.tick();
    expect(stats.notified).toBe(0);
    expect(sentCards).toHaveLength(1);
  });

  it("9. notify send failure is swallowed (Feishu hiccup must not crash the tick) and still recorded as attempted", async () => {
    const runId = await seedAwaitingRun({
      approval_timeout_minutes: 60,
      escalation_actions: [
        { at_minute: 15, action: "notify_feishu_group", target: "oc_dead" },
      ],
    });

    now += 16 * 60_000;
    const sched = startOperationsTimeoutScheduler({
      service,
      sendCard: async () => {
        throw new Error("feishu 500");
      },
      nowMs: () => now,
      onEvent: (tenantId, runId2, type, payload) => {
        sseEvents.push({ tenantId, runId: runId2, type, payload });
      },
    });
    const stats = await sched.tick();

    expect(stats.errors).toBe(1);
    const run = await service.getRun(tenantA, runId);
    expect(run.state).toBe("awaiting_approval"); // tick survived
    const events = await service.listEvents(tenantA, runId, 500);
    const marker = events.find((e) => e.action === "run.escalation");
    expect(JSON.parse(marker!.payload!)).toMatchObject({ delivered: false });
  });
});
