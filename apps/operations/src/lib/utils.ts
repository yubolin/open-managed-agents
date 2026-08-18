import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function shortHash(hash: string | null | undefined, len = 12): string {
  if (!hash) return "—";
  if (hash.length <= len + 4) return hash;
  return `${hash.slice(0, len)}...`;
}

export function getStateMeta(state: WorkspaceRunState): {
  label: string;
  badgeClass: string;
  dotClass: string;
  category: "pending" | "progress" | "approval" | "success" | "failure";
} {
  switch (state) {
    case "draft":
      return { label: "草稿 (Draft)", badgeClass: "bg-slate-800/80 text-slate-300 border-slate-700", dotClass: "bg-slate-400", category: "pending" };
    case "submitted":
      return { label: "已提交 (Submitted)", badgeClass: "bg-blue-950/60 text-blue-300 border-blue-800/50", dotClass: "bg-blue-400", category: "pending" };
    case "planning":
      return { label: "方案规划中 (Planning)", badgeClass: "bg-cyan-950/60 text-cyan-300 border-cyan-800/50 animate-pulse", dotClass: "bg-cyan-400", category: "progress" };
    case "awaiting_approval":
      return { label: "待审批 (Awaiting Approval)", badgeClass: "bg-amber-950/70 text-amber-300 border-amber-700/60 glow-amber", dotClass: "bg-amber-400 animate-ping", category: "approval" };
    case "changes_requested":
      return { label: "已要求修改 (Changes Requested)", badgeClass: "bg-orange-950/60 text-orange-300 border-orange-800/50", dotClass: "bg-orange-400", category: "approval" };
    case "approval_invalidated":
      return { label: "审批已失效 (Invalidated)", badgeClass: "bg-rose-950/70 text-rose-300 border-rose-800/60", dotClass: "bg-rose-400", category: "failure" };
    case "approved":
      return { label: "已批准 (Approved)", badgeClass: "bg-emerald-950/60 text-emerald-300 border-emerald-800/50", dotClass: "bg-emerald-400", category: "approval" };
    case "rejected":
      return { label: "已驳回 (Rejected)", badgeClass: "bg-red-950/70 text-red-300 border-red-800/60", dotClass: "bg-red-400", category: "failure" };
    case "executing":
      return { label: "正在执行 (Executing)", badgeClass: "bg-indigo-950/70 text-indigo-300 border-indigo-700/60 glow-emerald animate-pulse", dotClass: "bg-indigo-400", category: "progress" };
    case "succeeded":
      return { label: "执行成功 (Succeeded)", badgeClass: "bg-emerald-950/80 text-emerald-200 border-emerald-600/60 glow-emerald", dotClass: "bg-emerald-400", category: "success" };
    case "failed":
      return { label: "执行失败 (Failed)", badgeClass: "bg-red-950/80 text-red-200 border-red-700/60 glow-rose", dotClass: "bg-red-400", category: "failure" };
    case "cancelled":
      return { label: "已取消 (Cancelled)", badgeClass: "bg-zinc-800/80 text-zinc-400 border-zinc-700", dotClass: "bg-zinc-500", category: "pending" };
    case "interrupted":
      return { label: "已中断 (Interrupted)", badgeClass: "bg-yellow-950/70 text-yellow-300 border-yellow-800/50", dotClass: "bg-yellow-400", category: "failure" };
    default:
      return { label: state, badgeClass: "bg-slate-800 text-slate-300 border-slate-700", dotClass: "bg-slate-400", category: "pending" };
  }
}

/**
 * SoD guard: the applicant cannot approve their own run. The server-side
 * SoD check (Base B) is the authority; this UI guard is defense-in-depth.
 */
export function isSelfApproval(
  runCreatedBy: string | null | undefined,
  currentUserId: string
): boolean {
  return !!runCreatedBy && runCreatedBy === currentUserId;
}

/**
 * Required-field validation shared by DynamicForm (extracted from the
 * component so tests hit the real production path).
 */
export function validateRequiredFields(
  requiredFields: string[],
  values: Record<string, any>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of requiredFields) {
    if (values[field] === undefined || values[field] === null || values[field] === "") {
      errors[field] = "此项为必填项";
    }
  }
  return errors;
}

/** Current operator identity: localStorage override, demo persona fallback. */
export function getCurrentUserId(): string {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("openma_user_id") || "user_operator_bob";
  }
  return "user_operator_bob";
}
