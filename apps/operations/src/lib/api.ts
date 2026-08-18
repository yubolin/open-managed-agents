// Operations Workspace API Client (Base D)
// Pure typed consumption of @open-managed-agents/api-types

import type {
  CreateWorkspaceAuthTicketRequest,
  CreateWorkspaceRunRequest,
  DecideWorkspaceApprovalRequest,
  ReworkWorkspaceRunRequest,
  CancelWorkspaceRunRequest,
  WorkspaceApprovalsListResponse,
  WorkspaceArtifactsListResponse,
  WorkspaceAuthTicketResponse,
  WorkspaceRunDetailResponse,
  WorkspaceRunsListResponse,
  WorkspaceServiceTemplatesListResponse,
  WorkspaceTemplateVersionResponse,
} from "@open-managed-agents/api-types";

const BASE_URL = "/v1/workspace";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has("content-type") && options.body) {
    headers.set("content-type", "application/json");
  }

  // Inject active tenant if available in localStorage
  const tenantId =
    (typeof localStorage !== "undefined" ? localStorage.getItem("openma_tenant_id") : null) ||
    "tenant_default";
  headers.set("x-tenant-id", tenantId);

  // Operator identity when set (drives server-side audit actor + SoD);
  // absent header falls back to user_anonymous server-side.
  const userId =
    typeof localStorage !== "undefined" ? localStorage.getItem("openma_user_id") : null;
  if (userId) headers.set("x-user-id", userId);

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errMessage = `HTTP error ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string; code?: string };
      if (json.error) errMessage = json.error;
    } catch {
      // Ignored
    }
    throw new Error(errMessage);
  }

  return res.json() as Promise<T>;
}

export const operationsApi = {
  // 1. Templates
  getTemplates: async (category?: string) => {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    return request<WorkspaceServiceTemplatesListResponse>(`/templates${qs}`);
  },

  // GET /v1/workspace/templates/:id/version — template item + parsed version
  // (form_schema/approval_policy live on the version, not the template item)
  getTemplate: async (id: string, versionId?: string) => {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return request<WorkspaceTemplateVersionResponse>(`/templates/${id}/version${qs}`);
  },

  // 2. Runs
  getRuns: async (params?: { state?: string; template_id?: string; limit?: number; cursor?: string }) => {
    const sp = new URLSearchParams();
    if (params?.state) sp.set("state", params.state);
    if (params?.template_id) sp.set("template_id", params.template_id);
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.cursor) sp.set("cursor", params.cursor);
    const qs = sp.toString() ? `?${sp.toString()}` : "";
    return request<WorkspaceRunsListResponse>(`/runs${qs}`);
  },

  getRun: async (id: string) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}`);
  },

  createRun: async (data: CreateWorkspaceRunRequest) => {
    return request<WorkspaceRunDetailResponse>("/runs", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  submitRun: async (id: string) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}/submit`, {
      method: "POST",
    });
  },

  reworkRun: async (id: string, data: ReworkWorkspaceRunRequest) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}/rework`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  cancelRun: async (id: string, data?: CancelWorkspaceRunRequest) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  },

  getArtifacts: async (runId: string) => {
    return request<WorkspaceArtifactsListResponse>(`/runs/${runId}/artifacts`);
  },

  // 3. Approvals
  getApprovals: async (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return request<WorkspaceApprovalsListResponse>(`/approvals${qs}`);
  },

  approveRun: async (id: string, data?: DecideWorkspaceApprovalRequest) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  },

  rejectRun: async (id: string, data?: DecideWorkspaceApprovalRequest) => {
    return request<WorkspaceRunDetailResponse>(`/runs/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  },

  // 4. SSE Auth Ticket
  createAuthTicket: async (data?: CreateWorkspaceAuthTicketRequest) => {
    return request<WorkspaceAuthTicketResponse>("/auth/ticket", {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  },
};
