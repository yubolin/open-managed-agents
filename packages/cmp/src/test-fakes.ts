// In-memory FakeCmpConnector — dev + test double for the CmpConnector port,
// mirroring packages/aiops/src/test-fakes.ts conventions. Seed entities,
// runbooks, and opsdata per test; executions start "running" and complete on
// the next getExecution poll (or immediately when `autoComplete` is set).

import { randomBytes } from "node:crypto";
import type {
  CmdbEntity,
  CmdbRelationship,
  CmpExecution,
  CmpRunbook,
  ItsmTicket,
} from "./domain.js";
import type {
  AutomationExecuteInput,
  CmdbEntityQuery,
  CmpConnector,
  ItsmCreateTicketInput,
} from "./port.js";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export interface FakeCmpOptions {
  /** Complete executions immediately instead of on the next poll. */
  autoComplete?: boolean;
  /** now() — injectable clock. */
  now?: () => number;
}

export class FakeCmpConnector implements CmpConnector {
  readonly entities = new Map<string, CmdbEntity>();
  readonly relationships: CmdbRelationship[] = [];
  readonly runbooks = new Map<string, CmpRunbook>();
  readonly tickets = new Map<string, ItsmTicket>();
  readonly ticketNotes = new Map<string, string[]>();
  readonly executions = new Map<string, CmpExecution & { pending: boolean }>();

  private readonly autoComplete: boolean;
  private readonly now: () => number;

  constructor(opts: FakeCmpOptions = {}) {
    this.autoComplete = opts.autoComplete ?? false;
    this.now = opts.now ?? Date.now;
    seedDefaultRunbooks(this.runbooks);
  }

  readonly cmdb = {
    getEntity: async (query: CmdbEntityQuery): Promise<CmdbEntity | null> => {
      if (query.entity_id) return this.entities.get(query.entity_id) ?? null;
      for (const e of this.entities.values()) {
        if (query.hostname && e.hostname === query.hostname) return e;
        if (query.ip && e.ip === query.ip) return e;
      }
      return null;
    },
    getRelationships: async (entityId: string): Promise<CmdbRelationship[]> =>
      this.relationships.filter(
        (r) => r.source_id === entityId || r.target_id === entityId,
      ),
  };

  readonly itsm = {
    createTicket: async (input: ItsmCreateTicketInput): Promise<ItsmTicket> => {
      const ticket: ItsmTicket = {
        ticket_id: id("tkt"),
        title: input.title,
        status: "open",
        url: null,
        created_at: this.now(),
      };
      this.tickets.set(ticket.ticket_id, ticket);
      this.ticketNotes.set(ticket.ticket_id, []);
      return ticket;
    },
    appendNote: async (
      ticketId: string,
      note: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const notes = this.ticketNotes.get(ticketId);
      if (!notes) return { ok: false, error: `unknown ticket ${ticketId}` };
      if (!notes.includes(note)) notes.push(note);
      return { ok: true };
    },
    updateStatus: async (
      ticketId: string,
      status: ItsmTicket["status"],
    ): Promise<{ ok: boolean; error?: string }> => {
      const t = this.tickets.get(ticketId);
      if (!t) return { ok: false, error: `unknown ticket ${ticketId}` };
      t.status = status;
      return { ok: true };
    },
    getTicket: async (ticketId: string): Promise<ItsmTicket | null> =>
      this.tickets.get(ticketId) ?? null,
  };

  readonly automation = {
    listRunbooks: async (): Promise<CmpRunbook[]> =>
      [...this.runbooks.values()],
    dryRun: async (
      runbookId: string,
      params: Record<string, unknown>,
    ): Promise<{ ok: boolean; plan: string; error?: string }> => {
      const rb = this.runbooks.get(runbookId);
      if (!rb) return { ok: false, plan: "", error: `unknown runbook ${runbookId}` };
      return {
        ok: true,
        plan: `[dry-run] ${rb.name}(${JSON.stringify(params)}) — 无副作用预览`,
      };
    },
    execute: async (input: AutomationExecuteInput): Promise<CmpExecution> => {
      const rb = this.runbooks.get(input.runbook_id);
      if (!rb) throw new Error(`unknown runbook ${input.runbook_id}`);
      const execution: CmpExecution & { pending: boolean } = {
        execution_id: id("exec"),
        runbook_id: input.runbook_id,
        status: this.autoComplete ? "succeeded" : "running",
        output: this.autoComplete
          ? `[fake] ${rb.name} 完成（approval_id=${input.approval_id}）`
          : null,
        started_at: this.now(),
        pending: !this.autoComplete,
      };
      this.executions.set(execution.execution_id, execution);
      return this.strip(execution);
    },
    getExecution: async (
      executionId: string,
    ): Promise<CmpExecution | null> => {
      const e = this.executions.get(executionId);
      if (!e) return null;
      if (e.pending) {
        // First poll after start completes the fake execution.
        e.pending = false;
        e.status = "succeeded";
        e.output = `[fake] ${this.runbooks.get(e.runbook_id)?.name ?? e.runbook_id} 完成`;
      }
      return this.strip(e);
    },
  };

  readonly opsdata = {
    queryMetrics: async (q: {
      entity_id: string;
      metric: string;
      range: { from_ms: number; to_ms: number };
    }) => {
      void q;
      return [] as { ts: number; value: number }[];
    },
    queryLogs: async (q: {
      entity_id: string;
      keywords?: string[];
      range: { from_ms: number; to_ms: number };
    }) => {
      void q;
      return [] as { ts: number; severity: "info"; message: string }[];
    },
    queryEvents: async (q: {
      entity_id: string;
      range: { from_ms: number; to_ms: number };
    }) => {
      void q;
      return [] as { ts: number; kind: string; message: string }[];
    },
  };

  private strip(e: CmpExecution & { pending: boolean }): CmpExecution {
    const { pending: _pending, ...rest } = e;
    return rest;
  }
}

/** Seed helpers used by tests + the dev fake. */
export function seedDefaultRunbooks(map: Map<string, CmpRunbook>): void {
  const defaults: CmpRunbook[] = [
    {
      id: "rb_restart_service",
      name: "restart-service",
      description: "重启指定主机上的系统服务（低风险）",
      risk_level: "low",
      params_schema: {
        type: "object",
        properties: {
          hostname: { type: "string" },
          service: { type: "string" },
        },
        required: ["hostname", "service"],
      },
    },
    {
      id: "rb_scale_out",
      name: "scale-out",
      description: "为服务扩容一个实例（中风险，涉及变更）",
      risk_level: "medium",
      params_schema: {
        type: "object",
        properties: { service: { type: "string" }, count: { type: "number" } },
        required: ["service"],
      },
    },
    {
      id: "rb_disk_clean",
      name: "disk-clean",
      description: "清理主机磁盘空间（低风险）",
      risk_level: "low",
      params_schema: {
        type: "object",
        properties: { hostname: { type: "string" } },
        required: ["hostname"],
      },
    },
  ];
  for (const rb of defaults) map.set(rb.id, rb);
}
