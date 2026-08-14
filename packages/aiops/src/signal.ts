// Alert signal rendering — the user.message text an alert dispatch injects
// into a triage session (initial event, or a "another occurrence" resume).
//
// Modeled on packages/feishu/src/signal.ts: the envelope is runtime metadata;
// the AIOps triage protocol prompt tells the agent never to quote envelope
// structure back to humans.

import type { AiopsAlert } from "./domain.js";

/** The AIOps triage protocol prose appended to the triage agent's system
 *  prompt (via the agent definition itself in Phase 1 — a single-purpose
 *  digital employee, so the protocol lives in its system prompt rather than
 *  an additionalSystemPrompt mechanism). Kept here so the prompt and the
 *  envelope renderer evolve together. */
export const AIOPS_TRIAGE_PROTOCOL_PROMPT = [
  `<oma_aiops_triage_protocol>`,
  `告警分诊回合以 user.message 到达，文本包裹在 \`<oma_signal kind="alert_fired|alert_occurrence|alert_resolved">\` 信封里。信封是运行时元数据——永远不要向人类引用信号名、属性或信封结构。`,
  ``,
  `收到 alert_fired：按既定工作流完成分诊（解析 → CMDB 定位 → 查重 → 建单/补单 → 建议 → 提请审批）。`,
  `收到 alert_occurrence：同一指纹的新增一次。判断是否改变结论；多数情况下只需向工单追加一条备注。`,
  `收到 alert_resolved：来源已恢复。输出收口摘要并（如已有工单）追加恢复备注。`,
  `</oma_aiops_triage_protocol>`,
].join("\n");

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return "（无）";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function renderAnnotations(annotations: Record<string, string>): string {
  const entries = Object.entries(annotations).filter(
    ([, v]) => v && v.trim().length > 0,
  );
  if (!entries.length) return "（无）";
  return entries.map(([k, v]) => `${k}: ${v}`).join("\n");
}

/** Render the initial-event text for a newly dispatched alert. */
export function renderAlertSignal(alert: AiopsAlert): string {
  return [
    `<oma_signal kind="alert_fired" fingerprint="${alert.fingerprint}" severity="${alert.severity}">`,
    `告警：${alert.name}`,
    `级别：${alert.severity}`,
    `来源：${alert.source}`,
    `触发时间：${new Date(alert.startsAt).toISOString()}`,
    `标签：${renderLabels(alert.labels)}`,
    `描述：`,
    renderAnnotations(alert.annotations),
    `</oma_signal>`,
  ].join("\n");
}

/** Render the resume text for an additional occurrence on an open alert. */
export function renderAlertOccurrenceSignal(alert: AiopsAlert): string {
  return [
    `<oma_signal kind="alert_occurrence" fingerprint="${alert.fingerprint}" severity="${alert.severity}" dedup_count="${alert.dedupCount}">`,
    `同一告警新增一次（第 ${alert.dedupCount} 次）：${alert.name}`,
    `最新级别：${alert.severity}`,
    `标签：${renderLabels(alert.labels)}`,
    `</oma_signal>`,
  ].join("\n");
}

/** Render the resume text when the source reports recovery. */
export function renderAlertResolvedSignal(alert: AiopsAlert): string {
  return [
    `<oma_signal kind="alert_resolved" fingerprint="${alert.fingerprint}">`,
    `来源报告告警已恢复：${alert.name}`,
    `恢复时间：${new Date(alert.endsAt ?? Date.now()).toISOString()}`,
    `</oma_signal>`,
  ].join("\n");
}
