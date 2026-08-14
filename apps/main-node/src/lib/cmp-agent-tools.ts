// CMP agent tools for AIOps digital employees (enterprise line).
//
// Same shape as lib/feishu-agent-tools.ts: configure() once at boot inside
// the AIOPS_ENABLED block, resolveCmpAgentTools() per turn in the registry's
// buildHarnessContext, `{}` spread when unconfigured/not an AIOps agent.
//
// The gate that matters: cmp__automation_execute REFUSES to run unless a
// human-approved approval_requests row exists for THIS session and THIS
// runbook (verified server-side on every call). The model can pass no
// argument that bypasses it — 提请审批 (cmp__automation_request_approval)
// ends the agent's turn; a human decides via /v1/approvals/:id/decide; the
// decision continuation re-enters the session as a user.message turn.

import { tool } from "ai";
import { z } from "zod";
import type { CmpConnector } from "@open-managed-agents/cmp";
import type { SqlApprovalStore, ApprovalAction } from "./approval-store.js";

export interface CmpAgentToolConfig {
  approvals: SqlApprovalStore;
  cmp: CmpConnector;
  /** sessions-row reader: tenant + AIOps dispatch metadata. */
  readSessionInfo: (
    sessionId: string,
  ) => Promise<{ tenantId: string; alertId: string | null } | null>;
  /** Approval TTL for newly requested approvals. Default 24h. */
  approvalTtlMs?: number;
  /** Which agents get the tools. Defaults to the digital-employee check. */
  agentMatcher?: (agent: {
    metadata?: Record<string, unknown> | null;
  }) => boolean;
  now?: () => number;
}

let config: CmpAgentToolConfig | null = null;

export function configureCmpAgentTools(next: CmpAgentToolConfig): void {
  config = next;
}

export function resetCmpAgentTools(): void {
  config = null;
}

export function isAiopsDigitalEmployee(agent: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = agent.metadata;
  return (
    !!meta &&
    meta.kind === "digital_employee" &&
    meta.domain === "aiops"
  );
}

/** Resolve the CMP tool map for a session; `{}` unless the session's agent
 *  is an AIOps digital employee and the subsystem is configured. */
export async function resolveCmpAgentTools(
  sessionId: string,
  agent: { metadata?: Record<string, unknown> | null },
): Promise<Record<string, any>> {
  if (!config) return {};
  const matcher = config.agentMatcher ?? isAiopsDigitalEmployee;
  if (!matcher(agent)) return {};
  return buildCmpTools(sessionId, config);
}

/** Pure factory — exported for unit tests. */
export function buildCmpTools(
  sessionId: string,
  cfg: CmpAgentToolConfig,
): Record<string, any> {
  const now = cfg.now ?? Date.now;
  return {
    cmp__cmdb_lookup: tool({
      description:
        "在 CMDB 中定位实体（主机/数据库/中间件等）并返回其拓扑关系。任选 entity_id / hostname / ip 之一查询。",
      inputSchema: z.object({
        entity_id: z.string().optional(),
        hostname: z.string().optional(),
        ip: z.string().optional(),
      }),
      execute: async (q) => {
        const entity = await cfg.cmp.cmdb.getEntity(q);
        if (!entity) return { ok: false, error: "CMDB 中未找到匹配实体" };
        const rels = await cfg.cmp.cmdb.getRelationships(entity.id);
        return { ok: true, entity, relationships: rels };
      },
    }),

    cmp__itsm_ticket_create: tool({
      description: "在 ITSM 创建工单（分诊建单用）。返回 ticket_id。",
      inputSchema: z.object({
        title: z.string(),
        description: z.string(),
        severity: z.enum(["critical", "warning", "info"]),
      }),
      execute: async ({ title, description, severity }) => {
        const ticket = await cfg.cmp.itsm.createTicket({
          title,
          description,
          severity,
        });
        return { ok: true, ticket_id: ticket.ticket_id, url: ticket.url };
      },
    }),

    cmp__itsm_ticket_append: tool({
      description: "向已有 ITSM 工单追加备注（分析结论 / 执行结果 / 恢复摘要）。",
      inputSchema: z.object({
        ticket_id: z.string(),
        note: z.string(),
      }),
      execute: async ({ ticket_id, note }) => {
        const res = await cfg.cmp.itsm.appendNote(ticket_id, note);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
    }),

    cmp__automation_list: tool({
      description: "列出 CMP Automation 可用的运维剧本（runbook）及其风险级别。",
      inputSchema: z.object({}),
      execute: async () => {
        const runbooks = await cfg.cmp.automation.listRunbooks();
        return { ok: true, runbooks };
      },
    }),

    cmp__automation_request_approval: tool({
      description:
        "为一次自动化处置动作提请人工审批。创建审批请求后本回合即告结束——等待人类在审批队列中批准或拒绝；审批结果会以新消息回到本会话。不要在同一回合内继续尝试执行。",
      inputSchema: z.object({
        runbook_id: z.string(),
        params: z.record(z.string(), z.unknown()),
        summary: z.string().describe("给审批人看的一句话动作说明"),
      }),
      execute: async ({ runbook_id, params, summary }) => {
        const info = await cfg.readSessionInfo(sessionId);
        if (!info) return { ok: false, error: "会话信息不可读" };
        const action: ApprovalAction = {
          kind: "automation_execute",
          runbook_id,
          params,
          summary,
        };
        const approval = await cfg.approvals.create({
          tenantId: info.tenantId,
          sessionId,
          alertId: info.alertId,
          action,
          requestedBy: "agent",
          expiresAt: now() + (cfg.approvalTtlMs ?? 24 * 3600_000),
          nowMs: now(),
        });
        return {
          ok: true,
          approval_id: approval.id,
          note: "已提请人工审批。请结束本回合等待审批结果；批准后你会收到继续执行的消息。",
        };
      },
    }),

    cmp__automation_execute: tool({
      description:
        "执行一个人工已批准的自动化处置动作。必须传审批返回的 approval_id；未经批准的调用会被拒绝。执行完成后请把结果回写 ITSM 工单。",
      inputSchema: z.object({
        runbook_id: z.string(),
        params: z.record(z.string(), z.unknown()),
        approval_id: z.string(),
      }),
      execute: async ({ runbook_id, params, approval_id }) => {
        const gate = await checkExecuteGate(cfg, sessionId, runbook_id, approval_id, now());
        if (!gate.ok) return gate;
        try {
          const exec = await cfg.cmp.automation.execute({
            runbook_id,
            params,
            approval_id,
          });
          return { ok: true, execution: exec };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    cmp__automation_execution_status: tool({
      description: "查询一次自动化执行的当前状态。",
      inputSchema: z.object({ execution_id: z.string() }),
      execute: async ({ execution_id }) => {
        const exec = await cfg.cmp.automation.getExecution(execution_id);
        return exec ? { ok: true, execution: exec } : { ok: false, error: "未找到该执行" };
      },
    }),
  };
}

/** Server-side approval gate — every execute call re-verifies:
 *  approved status, this session, this runbook, not expired. */
export async function checkExecuteGate(
  cfg: CmpAgentToolConfig,
  sessionId: string,
  runbookId: string,
  approvalId: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const approval = await cfg.approvals.get(approvalId);
  if (!approval) return { ok: false, error: `审批记录 ${approvalId} 不存在` };
  if (approval.sessionId !== sessionId)
    return { ok: false, error: "审批记录不属于当前会话，拒绝执行" };
  if (approval.action.kind !== "automation_execute" || approval.action.runbook_id !== runbookId)
    return { ok: false, error: "审批记录对应的动作与本次执行不一致，拒绝执行" };
  if (approval.status === "expired" || nowMs > approval.expiresAt)
    return { ok: false, error: "审批已过期；请重新提请审批" };
  if (approval.status !== "approved")
    return {
      ok: false,
      error: `审批状态为 ${approval.status}，尚未获得人工批准；请等待审批结果`,
    };
  return { ok: true };
}
