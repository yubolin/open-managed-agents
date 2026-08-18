// In-memory test fake implementation of OperationsStorePort.

import type { ListRunsOptions, OperationsStorePort } from "./ports";
import type {
  RunApprovalRow,
  RunArtifactRow,
  RunEventRow,
  RunRow,
  RunState,
  ServiceTemplateRow,
  ServiceTemplateVersionRow,
} from "./types";

export class InMemoryOperationsStore implements OperationsStorePort {
  public templates = new Map<string, ServiceTemplateRow>();
  public templateVersions = new Map<string, ServiceTemplateVersionRow>();
  public runs = new Map<string, RunRow>();
  public approvals = new Map<string, RunApprovalRow>();
  public artifacts = new Map<string, RunArtifactRow>();
  public events: RunEventRow[] = [];

  private runKey(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }

  async getTemplate(tenantId: string, templateId: string): Promise<ServiceTemplateRow | null> {
    const t = this.templates.get(this.runKey(tenantId, templateId));
    return t ? { ...t } : null;
  }

  async getTemplateByCode(tenantId: string, code: string): Promise<ServiceTemplateRow | null> {
    for (const t of this.templates.values()) {
      if (t.tenant_id === tenantId && t.code === code) {
        return { ...t };
      }
    }
    return null;
  }

  async listTemplates(
    tenantId: string,
    category?: string,
    onlyActive = true
  ): Promise<ServiceTemplateRow[]> {
    return Array.from(this.templates.values())
      .filter((t) => {
        if (t.tenant_id !== tenantId) return false;
        if (onlyActive && t.is_active !== 1) return false;
        if (category && t.category !== category) return false;
        return true;
      })
      .map((t) => ({ ...t }));
  }

  async getTemplateVersion(
    tenantId: string,
    versionId: string
  ): Promise<ServiceTemplateVersionRow | null> {
    const v = this.templateVersions.get(this.runKey(tenantId, versionId));
    return v ? { ...v } : null;
  }

  async getLatestTemplateVersion(
    tenantId: string,
    templateId: string
  ): Promise<ServiceTemplateVersionRow | null> {
    const versions = Array.from(this.templateVersions.values())
      .filter((v) => v.tenant_id === tenantId && v.template_id === templateId)
      .sort((a, b) => b.version - a.version);
    return versions[0] ? { ...versions[0] } : null;
  }

  async insertTemplate(
    template: ServiceTemplateRow,
    initialVersion: ServiceTemplateVersionRow
  ): Promise<void> {
    this.templates.set(this.runKey(template.tenant_id, template.id), { ...template });
    this.templateVersions.set(this.runKey(initialVersion.tenant_id, initialVersion.id), {
      ...initialVersion,
    });
  }

  async insertTemplateVersion(version: ServiceTemplateVersionRow): Promise<void> {
    this.templateVersions.set(this.runKey(version.tenant_id, version.id), { ...version });
  }

  async setTemplateVersionActive(
    tenantId: string,
    versionId: string,
    isActive: boolean
  ): Promise<void> {
    const v = this.templateVersions.get(this.runKey(tenantId, versionId));
    if (v) {
      v.is_active = isActive ? 1 : 0;
    }
  }

  async getRun(tenantId: string, runId: string): Promise<RunRow | null> {
    const r = this.runs.get(this.runKey(tenantId, runId));
    return r ? { ...r } : null;
  }

  async listRuns(tenantId: string, options?: ListRunsOptions): Promise<RunRow[]> {
    let list = Array.from(this.runs.values()).filter((r) => r.tenant_id === tenantId);
    if (options?.state) {
      list = list.filter((r) => r.state === options.state);
    }
    if (options?.createdBy) {
      list = list.filter((r) => r.created_by === options.createdBy);
    }
    if (options?.serviceTemplateId) {
      list = list.filter((r) => r.service_template_id === options.serviceTemplateId);
    }
    list.sort((a, b) => b.created_at - a.created_at);
    if (options?.offset) {
      list = list.slice(options.offset);
    }
    if (options?.limit) {
      list = list.slice(0, options.limit);
    }
    return list.map((r) => ({ ...r }));
  }

  async listAwaitingApprovalRunsSystem(limit: number): Promise<RunRow[]> {
    const list = Array.from(this.runs.values())
      .filter((r) => r.state === "awaiting_approval")
      .sort((a, b) => a.updated_at - b.updated_at)
      .slice(0, limit);
    return list.map((r) => ({ ...r }));
  }

  async insertRun(run: RunRow): Promise<void> {
    this.runs.set(this.runKey(run.tenant_id, run.id), { ...run });
  }

  async updateRunCAS(
    tenantId: string,
    runId: string,
    fromState: RunState,
    updates: Partial<RunRow>
  ): Promise<boolean> {
    const key = this.runKey(tenantId, runId);
    const existing = this.runs.get(key);
    if (!existing || existing.state !== fromState) {
      return false;
    }
    this.runs.set(key, {
      ...existing,
      ...updates,
      updated_at: updates.updated_at ?? Date.now(),
    });
    return true;
  }

  async insertApproval(approval: RunApprovalRow): Promise<void> {
    this.approvals.set(approval.id, { ...approval });
  }

  async listApprovals(tenantId: string, runId: string): Promise<RunApprovalRow[]> {
    return Array.from(this.approvals.values())
      .filter((a) => a.tenant_id === tenantId && a.run_id === runId)
      .sort((a, b) => a.created_at - b.created_at)
      .map((a) => ({ ...a }));
  }

  async getActiveApproval(tenantId: string, runId: string): Promise<RunApprovalRow | null> {
    const list = await this.listApprovals(tenantId, runId);
    const active = list.filter((a) => a.is_invalidated === 0 && a.decision === "approved");
    return active[active.length - 1] ?? null;
  }

  async invalidateApprovals(
    tenantId: string,
    runId: string,
    reason: string,
    now: number
  ): Promise<void> {
    for (const a of this.approvals.values()) {
      if (a.tenant_id === tenantId && a.run_id === runId && a.is_invalidated === 0) {
        a.is_invalidated = 1;
        a.invalidated_reason = reason;
        a.invalidated_at = now;
      }
    }
  }

  async insertArtifact(artifact: RunArtifactRow): Promise<void> {
    this.artifacts.set(artifact.id, { ...artifact });
  }

  async listArtifacts(tenantId: string, runId: string, type?: string): Promise<RunArtifactRow[]> {
    return Array.from(this.artifacts.values())
      .filter((a) => {
        if (a.tenant_id !== tenantId || a.run_id !== runId) return false;
        if (type && a.type !== type) return false;
        return true;
      })
      .sort((a, b) => a.version - b.version)
      .map((a) => ({ ...a }));
  }

  async getLatestArtifact(
    tenantId: string,
    runId: string,
    type: string
  ): Promise<RunArtifactRow | null> {
    const list = await this.listArtifacts(tenantId, runId, type);
    return list[list.length - 1] ?? null;
  }

  async insertEvent(event: RunEventRow): Promise<void> {
    this.events.push({ ...event });
  }

  async listEvents(tenantId: string, runId?: string, limit = 100): Promise<RunEventRow[]> {
    return this.events
      .filter((e) => {
        if (e.tenant_id !== tenantId) return false;
        if (runId && e.run_id !== runId) return false;
        return true;
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async transaction<T>(fn: (tx: OperationsStorePort) => Promise<T>): Promise<T> {
    // In-memory fake executes synchronously
    return fn(this);
  }
}
