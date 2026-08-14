// The aiops-dispatch wire protocol between the supervisor agent and this
// gateway. The supervisor system prompt (scripts/seed-aiops-digital-employees.ts
// DISPATCH_PROTOCOL) emits a fenced JSON block; the gateway parses it, runs the
// expert rounds, and injects opinions back into the supervisor session.

export interface Dispatch {
  experts: string[];
  question: string;
  context?: string;
}

const FENCE = /```aiops-dispatch[^\n]*\n([\s\S]*?)```/;

/**
 * Extract the first well-formed aiops-dispatch block from a supervisor reply.
 * Returns null when the reply carries no dispatch (== final conclusion turn)
 * or the block is malformed — malformed never throws, the supervisor simply
 * gets treated as done and its text surfaces verbatim.
 */
export function extractDispatch(text: string): Dispatch | null {
  const match = FENCE.exec(text);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<Dispatch>;
    if (typeof parsed.question !== "string" || !Array.isArray(parsed.experts)) {
      return null;
    }
    return {
      experts: parsed.experts.filter((e): e is string => typeof e === "string"),
      question: parsed.question,
      context: typeof parsed.context === "string" ? parsed.context : undefined,
    };
  } catch {
    return null;
  }
}

export interface ExpertOpinion {
  expertId: string;
  label: string;
  round: 1 | 2;
  text: string;
}

/**
 * Render the expert opinions as the injected user.message. Attribution is
 * explicit (PRD FR-3: agent speech must never masquerade as human input) —
 * the wrapper tag + per-opinion byline makes the provenance unmissable.
 */
export function renderOpinions(
  dispatch: Dispatch,
  opinions: ExpertOpinion[],
): string {
  const byRound = (round: 1 | 2) =>
    opinions
      .filter((o) => o.round === round)
      .map((o) => `【${o.label}】\n${o.text.trim()}`)
      .join("\n\n");

  const lines = [
    "<aiops_expert_opinions>",
    `问题：${dispatch.question}`,
    dispatch.context ? `背景：${dispatch.context}` : "",
    "",
    "—— 第 1 轮（独立分析）——",
    byRound(1) || "（本轮无有效意见）",
    "",
    "—— 第 2 轮（互评补充）——",
    byRound(2) || "（本轮无有效意见）",
    "</aiops_expert_opinions>",
    "",
    "以上是编排网关注入的专家意见（非用户输入）。请按工作协议输出最终结论；如确需追问，可再输出一次派单块。",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

export const FORCE_FINAL_PROMPT = [
  "<aiops_gateway>",
  "会诊轮次已达上限，不再安排新的专家轮次。",
  "请基于当前已获得的全部信息，立即输出最终结论（按约定分节格式）。",
  "</aiops_gateway>",
].join("\n");
