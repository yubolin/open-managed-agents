// Base E · timeout_policy parsing (template spec §3.2, adjudication 5).
//
// The scheduler's ONLY action vocabulary comes from the published schema:
//   notify_feishu_group          — card into a Feishu group chat (target = chat_id)
//   notify_process_owner         — notify the process owner (channel hint)
//   mark_approval_overdue_and_cancel — system cancel via state-matrix row 3,
//                                 cancel_reason=approval_timeout; NEVER an
//                                 auto-approve path (裁决 5 system invariant).
//
// The parser is total: malformed input yields null instead of throwing — a
// bad template version must never crash the scheduler tick loop. Unknown
// action values are dropped (not fatal) so newer template vocabularies
// degrade gracefully on older schedulers.

/** §3.2 escalation action vocabulary (exhaustive). */
export type EscalationActionType =
  | "notify_feishu_group"
  | "notify_process_owner"
  | "mark_approval_overdue_and_cancel";

export interface EscalationActionRule {
  /** Absolute minute (since entering awaiting_approval) when the action fires. */
  atMinute: number;
  action: EscalationActionType;
  /** notify_feishu_group: Feishu chat_id (oc_...). */
  target?: string;
  /** notify_process_owner: channel hint (e.g. feishu_direct_message). */
  channel?: string;
  /** mark_approval_overdue_and_cancel: final_state_behavior (spec: "cancelled"). */
  finalStateBehavior?: string;
}

export interface ParsedTimeoutPolicy {
  approvalTimeoutMinutes: number;
  escalationIntervalMinutes: number | null;
  /** Sorted ascending by atMinute. */
  actions: EscalationActionRule[];
}

const ACTION_TYPES: readonly EscalationActionType[] = [
  "notify_feishu_group",
  "notify_process_owner",
  "mark_approval_overdue_and_cancel",
];

function isFinitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Parse a template version's timeout_policy TEXT column. Null = unusable. */
export function parseTimeoutPolicy(
  raw: string | null | undefined,
): ParsedTimeoutPolicy | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (!isFinitePositiveNumber(obj.approval_timeout_minutes)) return null;
  if (!Array.isArray(obj.escalation_actions)) return null;

  const intervalRaw = obj.escalation_interval_minutes;
  const escalationIntervalMinutes = isFinitePositiveNumber(intervalRaw)
    ? intervalRaw
    : null;

  const actions: EscalationActionRule[] = [];
  for (const entry of obj.escalation_actions) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const at = e.at_minute;
    const action = e.action;
    if (!isFinitePositiveNumber(at)) continue;
    if (typeof action !== "string" || !ACTION_TYPES.includes(action as EscalationActionType)) {
      continue;
    }
    actions.push({
      atMinute: at,
      action: action as EscalationActionType,
      ...(typeof e.target === "string" ? { target: e.target } : {}),
      ...(typeof e.channel === "string" ? { channel: e.channel } : {}),
      ...(typeof e.final_state_behavior === "string"
        ? { finalStateBehavior: e.final_state_behavior }
        : {}),
    });
  }
  actions.sort((a, b) => a.atMinute - b.atMinute);

  return { approvalTimeoutMinutes: obj.approval_timeout_minutes, escalationIntervalMinutes, actions };
}

/** Actions whose at_minute threshold has been reached (ascending, no dupes). */
export function escalationActionsDue(
  policy: ParsedTimeoutPolicy,
  elapsedMinutes: number,
): EscalationActionRule[] {
  return policy.actions.filter((a) => a.atMinute <= elapsedMinutes);
}

/** Stable dedup key persisted in run_events payload — one chance per action. */
export function escalationDedupKey(rule: EscalationActionRule): string {
  return `${rule.action}:${rule.atMinute}`;
}
