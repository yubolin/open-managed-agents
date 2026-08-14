// Gateway-orchestrated discussion state machine (PRD FR-3 semantics, external).
//
// supervisor turn ──aiops-dispatch──▶ expert round 1 (parallel)
//        ▲                                   │
//        │                            expert round 2 (peer review)
//        └──── <aiops_expert_opinions> ───────┘
//   then: final conclusion (or one re-dispatch, capped by maxSupervisorTurns)
//
// All agent reasoning happens inside OMA harness sessions driven through the
// public REST boundary; this process only routes text. Expert sessions are
// sticky per orchestrator instance so each expert keeps its conversational
// context across rounds (mirrors the validated feishu-triage spike).

import type { OmaClient } from "./oma.js";
import {
  type Dispatch,
  type ExpertOpinion,
  extractDispatch,
  FORCE_FINAL_PROMPT,
  renderOpinions,
} from "./protocol.js";

export type ExpertId = "sre" | "network" | "db" | "security";

export interface ExpertRole {
  id: ExpertId;
  label: string;
  agentId: string;
}

export interface TranscriptEntry {
  speaker: string;
  kind: "supervisor" | "expert" | "system";
  text: string;
}

export interface DiscussionResult {
  conclusion: string;
  transcript: TranscriptEntry[];
  supervisorSessionId: string;
  expertSessionIds: Record<string, string>;
}

export interface OrchestratorOptions {
  supervisorAgentId: string;
  experts: ExpertRole[];
  maxSupervisorTurns?: number;
  /** Progress sink (CLI prints; watch logs). */
  onProgress?: (line: string) => void;
}

const ROUND1_TASK = "针对问题给出「可能原因 / 需核实的指标与日志 / 初步判断」。";
const ROUND2_TASK = "在此基础上补充、纠正或反驳，并指出最大的风险点。";

export class Orchestrator {
  private readonly oma: OmaClient;
  private readonly opts: Required<Pick<OrchestratorOptions, "supervisorAgentId" | "maxSupervisorTurns">> &
    OrchestratorOptions;
  private readonly expertSessions = new Map<ExpertId, string>();

  constructor(oma: OmaClient, opts: OrchestratorOptions) {
    this.oma = oma;
    this.opts = { maxSupervisorTurns: 3, ...opts };
  }

  private progress(line: string): void {
    this.opts.onProgress?.(line);
  }

  private async expertSessionId(role: ExpertRole, discussionId: string): Promise<string> {
    const cached = this.expertSessions.get(role.id);
    if (cached) return cached;
    const id = await this.oma.createSession(
      role.agentId,
      `AIOps 会诊 ${discussionId} · ${role.label}`,
    );
    this.expertSessions.set(role.id, id);
    return id;
  }

  private pickExperts(dispatch: Dispatch): ExpertRole[] {
    const wanted = new Set(dispatch.experts);
    const chosen = this.opts.experts.filter((e) => wanted.has(e.id));
    return chosen.length > 0 ? chosen : this.opts.experts.slice(0, 3);
  }

  private async expertTurn(
    role: ExpertRole,
    discussionId: string,
    prompt: string,
  ): Promise<string> {
    const sessionId = await this.expertSessionId(role, discussionId);
    const reply = await this.oma.turn(sessionId, prompt);
    return reply.text;
  }

  /**
   * Continue an existing supervisor session whose last reply has already been
   * produced (watch mode reuses this; run() calls it after the opening turn).
   */
  async continueFrom(
    supervisorSessionId: string,
    openingReply: string,
    discussionId: string,
  ): Promise<DiscussionResult> {
    const transcript: TranscriptEntry[] = [
      { speaker: "值班主管", kind: "supervisor", text: openingReply },
    ];
    let reply = openingReply;

    for (let turn = 1; turn <= this.opts.maxSupervisorTurns; turn++) {
      const dispatch = extractDispatch(reply);
      if (!dispatch) {
        return this.finish(transcript, reply, supervisorSessionId);
      }

      const chosen = this.pickExperts(dispatch);
      const opinions: ExpertOpinion[] = [];

      // Phase A: round 1 — every expert in parallel (PRD: 首轮并行).
      const r1Results = await Promise.allSettled(
        chosen.map(async (role) => {
          const r1Prompt = [
            `<aiops_dispatch from="值班主管">`,
            `问题：${dispatch.question}`,
            dispatch.context ? `背景：${dispatch.context}` : "",
            `</aiops_dispatch>`,
            ROUND1_TASK,
          ]
            .filter(Boolean)
            .join("\n");
          this.progress(`→ ${role.label} 第 1 轮…`);
          const text = await this.expertTurn(role, discussionId, r1Prompt);
          return { role, text };
        }),
      );
      const r1Done = r1Results.map((r, i) =>
        r.status === "fulfilled"
          ? { role: chosen[i]!, label: chosen[i]!.label, text: r.value.text }
          : {
              role: chosen[i]!,
              label: chosen[i]!.label,
              text: `（该专家本轮未能给出意见：${errMsg(r.reason)}）`,
            },
      );
      for (const r of r1Done) {
        transcript.push({ speaker: r.label, kind: "expert", text: r.text });
        opinions.push({ expertId: r.role.id, label: r.label, round: 1, text: r.text });
      }

      // Phase B: round 2 peer review — everyone sees everyone's round 1.
      const peers = r1Done.map((r) => ({ label: r.label, text: r.text }));
      const r2Results = await Promise.allSettled(
        chosen.map(async (role) => {
          const peerBlock =
            peers.length > 0
              ? peers.map((p) => `- ${p.label}：${p.text}`).join("\n")
              : "(其他专家本轮无有效意见)";
          const r2Prompt = [
            `<aiops_dispatch from="值班主管">`,
            `问题：${dispatch.question}`,
            `</aiops_dispatch>`,
            "其他专家第一轮意见：",
            peerBlock,
            "",
            ROUND2_TASK,
          ].join("\n");
          this.progress(`→ ${role.label} 第 2 轮（互评）…`);
          const text = await this.expertTurn(role, discussionId, r2Prompt);
          return { role, text };
        }),
      );
      r2Results.forEach((r, i) => {
        const role = chosen[i]!;
        const text =
          r.status === "fulfilled"
            ? r.value.text
            : `（该专家本轮未能给出意见：${errMsg(r.reason)}）`;
        transcript.push({ speaker: role.label, kind: "expert", text });
        opinions.push({ expertId: role.id, label: role.label, round: 2, text });
      });

      this.progress(`→ 值班主管汇总…`);
      reply = (await this.oma.turn(supervisorSessionId, renderOpinions(dispatch, opinions))).text;
      transcript.push({ speaker: "值班主管", kind: "supervisor", text: reply });
    }

    // Turn budget exhausted and the supervisor still wants experts — force it
    // closed so the discussion never dangles (PRD: must summarize or fail
    // explicitly, never silently loop).
    this.progress("→ 轮次已达上限，要求值班主管收口…");
    reply = (await this.oma.turn(supervisorSessionId, FORCE_FINAL_PROMPT)).text;
    transcript.push({ speaker: "值班主管", kind: "system", text: reply });
    return this.finish(transcript, reply, supervisorSessionId);
  }

  /** CLI entry: fresh supervisor session, opening question, full discussion. */
  async run(question: string): Promise<DiscussionResult> {
    const discussionId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const supervisorSessionId = await this.oma.createSession(
      this.opts.supervisorAgentId,
      `AIOps 会诊 ${discussionId}`,
    );
    this.progress(`→ 值班主管受理… (session ${supervisorSessionId})`);
    const opening = await this.oma.turn(supervisorSessionId, question);
    return this.continueFrom(supervisorSessionId, opening.text, discussionId);
  }

  private finish(
    transcript: TranscriptEntry[],
    conclusion: string,
    supervisorSessionId: string,
  ): DiscussionResult {
    const expertSessionIds: Record<string, string> = {};
    for (const [id, sid] of this.expertSessions) expertSessionIds[id] = sid;
    return { conclusion, transcript, supervisorSessionId, expertSessionIds };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
