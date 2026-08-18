// Base E · timeout_policy parser (template spec §3.2) — pure logic tests.
// The scheduler's semantics grow from the published schema:
//   { approval_timeout_minutes, escalation_interval_minutes, escalation_actions[] }
// Actions: notify_feishu_group | notify_process_owner | mark_approval_overdue_and_cancel.
// Parser is total: ANY malformed input yields null (scheduler skips the run),
// never throws — a bad template must not crash the tick loop.

import { describe, expect, it } from "vitest";
import {
  escalationActionsDue,
  escalationDedupKey,
  parseTimeoutPolicy,
} from "@open-managed-agents/operations-store";

const SPEC_SAMPLE = JSON.stringify({
  approval_timeout_minutes: 60,
  escalation_interval_minutes: 15,
  escalation_actions: [
    { at_minute: 15, action: "notify_feishu_group", target: "oc_feishu_sre_duty_chat" },
    { at_minute: 30, action: "notify_process_owner", channel: "feishu_direct_message" },
    { at_minute: 60, action: "mark_approval_overdue_and_cancel", final_state_behavior: "cancelled" },
  ],
});

describe("Base E · parseTimeoutPolicy (template spec §3.2)", () => {
  it("1. Parses the spec sample exactly (three action vocabulary)", () => {
    const policy = parseTimeoutPolicy(SPEC_SAMPLE);
    expect(policy).not.toBeNull();
    expect(policy!.approvalTimeoutMinutes).toBe(60);
    expect(policy!.escalationIntervalMinutes).toBe(15);
    expect(policy!.actions).toHaveLength(3);
    expect(policy!.actions[0]).toEqual({
      atMinute: 15,
      action: "notify_feishu_group",
      target: "oc_feishu_sre_duty_chat",
    });
    expect(policy!.actions[2]).toEqual({
      atMinute: 60,
      action: "mark_approval_overdue_and_cancel",
      finalStateBehavior: "cancelled",
    });
  });

  it("2. Returns null on unusable input (never throws)", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "{not json",
      JSON.stringify({ escalation_actions: [] }), // missing approval_timeout_minutes
      JSON.stringify({ approval_timeout_minutes: 30 }), // missing escalation_actions
      JSON.stringify({ approval_timeout_minutes: 30, escalation_actions: "nope" }), // actions not array
      JSON.stringify({ approval_timeout_minutes: "x", escalation_actions: [] }), // non-numeric timeout
    ]) {
      expect(parseTimeoutPolicy(bad as string | null), `input=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("3. Drops malformed entries, keeps the valid remainder (forward compat: unknown future actions ignored)", () => {
    const policy = parseTimeoutPolicy(
      JSON.stringify({
        approval_timeout_minutes: 30,
        escalation_actions: [
          { at_minute: 5, action: "notify_feishu_group", target: "oc_1" },
          { at_minute: 10, action: "reassign_to_somebody" }, // not in §3.2 vocabulary
          { action: "notify_feishu_group", target: "oc_2" }, // missing at_minute
          { at_minute: "soon", action: "notify_feishu_group" }, // non-numeric at_minute
          { at_minute: 20, action: "mark_approval_overdue_and_cancel" },
        ],
      }),
    );
    expect(policy!.actions).toHaveLength(2);
    expect(policy!.actions.map((a) => a.atMinute)).toEqual([5, 20]);
  });

  it("4. escalation_interval_minutes is optional (parsed as null when absent)", () => {
    const policy = parseTimeoutPolicy(
      JSON.stringify({ approval_timeout_minutes: 30, escalation_actions: [] }),
    );
    expect(policy!.escalationIntervalMinutes).toBeNull();
  });
});

describe("Base E · escalationActionsDue + dedup key", () => {
  it("5. Due = atMinute <= elapsed, ascending; empty when nothing due", () => {
    const policy = parseTimeoutPolicy(SPEC_SAMPLE)!;
    expect(escalationActionsDue(policy, 5)).toHaveLength(0);
    expect(escalationActionsDue(policy, 15).map((a) => a.action)).toEqual([
      "notify_feishu_group",
    ]);
    // 60 = exactly at the boundary -> cancel action is due
    expect(escalationActionsDue(policy, 60).map((a) => a.action)).toEqual([
      "notify_feishu_group",
      "notify_process_owner",
      "mark_approval_overdue_and_cancel",
    ]);
    expect(escalationActionsDue(policy, 9999)).toHaveLength(3); // capped, no duplicates
  });

  it("6. Dedup key is action:atMinute (stable across ticks)", () => {
    const policy = parseTimeoutPolicy(SPEC_SAMPLE)!;
    expect(escalationDedupKey(policy.actions[0]!)).toBe("notify_feishu_group:15");
    expect(escalationDedupKey(policy.actions[2]!)).toBe("mark_approval_overdue_and_cancel:60");
  });
});
