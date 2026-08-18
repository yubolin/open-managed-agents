import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  CheckSquare,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import { operationsApi } from "../lib/api";
import { StateBadge } from "../components/StateBadge";
import { HashBadge } from "../components/HashBadge";
import { cn, getCurrentUserId, isSelfApproval } from "../lib/utils";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";

export function ApprovalsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeAction, setActiveAction] = useState<{
    runId: string;
    action: "approve" | "reject" | "request_changes";
    title: string;
  } | null>(null);

  const [comment, setComment] = useState("");

  // Current operator identity for the client-side SoD guard (demo persona
  // fallback until real auth lands; server-side SoD remains the authority)
  const currentUserId = getCurrentUserId();

  // Query pending approvals
  const { data, isLoading } = useQuery({
    queryKey: ["workspace", "approvals"],
    queryFn: () => operationsApi.getApprovals("pending"),
  });

  const approvals = data?.approvals || [];

  // Approve Mutation
  const approveMutation = useMutation({
    mutationFn: ({ runId, comment }: { runId: string; comment?: string }) =>
      operationsApi.approveRun(runId, { comment }),
    onSuccess: () => {
      setActiveAction(null);
      setComment("");
      queryClient.invalidateQueries({ queryKey: ["workspace", "approvals"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", "runs"] });
    },
  });

  // Reject / Request Changes Mutation
  const rejectMutation = useMutation({
    mutationFn: ({
      runId,
      action,
      comment,
    }: {
      runId: string;
      action: "reject" | "request_changes";
      comment?: string;
    }) => operationsApi.rejectRun(runId, { action, comment }),
    onSuccess: () => {
      setActiveAction(null);
      setComment("");
      queryClient.invalidateQueries({ queryKey: ["workspace", "approvals"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", "runs"] });
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <CheckSquare className="w-5 h-5 text-emerald-400" />
            <span>待办与审批中心 (Approval Center)</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            双哈希防篡改 CAS 守卫与 SoD 申请人自审批阻断，保障企业级生产变更合规安全。
          </p>
        </div>

        <div className="flex items-center gap-2 self-start">
          <span className="text-xs text-slate-400">待办数量:</span>
          <span className="px-2.5 py-0.5 rounded-full bg-amber-950/80 border border-amber-800 text-amber-300 font-mono text-xs font-bold">
            {approvals.length}
          </span>
        </div>
      </div>

      {/* Approvals List */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="glass-panel rounded-xl p-6 h-40 animate-pulse bg-slate-900/40" />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <div className="glass-panel rounded-xl p-12 text-center border border-slate-800">
          <CheckCircle2 className="w-10 h-10 text-emerald-500/60 mx-auto mb-3" />
          <div className="text-sm font-semibold text-slate-200">当前无待处理的审批任务</div>
          <div className="text-xs text-slate-500 mt-1">所有运维方案与变更工单均已处理完毕。</div>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((appr) => {
            // SoD Check: if run applicant is current user -> self-approval forbidden
            const isSelfCreated = isSelfApproval(appr.created_by, currentUserId);

            return (
              <div
                key={appr.run_id}
                className="glass-panel rounded-xl p-5 border border-slate-800/90 space-y-4 hover:border-slate-700 transition-colors"
              >
                {/* Top Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs text-slate-400">{appr.run_id}</span>
                    <h3 className="text-sm font-bold text-slate-100">{appr.title}</h3>
                    <StateBadge state={appr.state as WorkspaceRunState} />
                    <span className="px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-amber-300 text-[11px] font-mono">
                      Stage {appr.current_stage}: {appr.stage_name}
                    </span>
                  </div>

                  <button
                    onClick={() => navigate(`/runs/${appr.run_id}`)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-emerald-400 transition-colors self-start sm:self-auto"
                  >
                    <span>查看完整工单</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>

                {/* Metadata & Dual Hash */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-slate-400">
                      <span>申请人:</span>
                      <span className="font-mono text-slate-200">{appr.created_by}</span>
                      {isSelfCreated && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-800 text-rose-300 font-mono">
                          您自己发起的工单
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                      <span>审批组:</span>
                      <span className="font-mono text-slate-200">{appr.group_id}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <HashBadge label="方案指纹" hash={appr.plan_hash} />
                    <HashBadge label="现场证据" hash={appr.evidence_snapshot_hash} />
                  </div>
                </div>

                {/* SoD Warning Banner if applicant is current user */}
                {isSelfCreated && (
                  <div className="flex items-center gap-2 p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-xs text-rose-300">
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>
                      <strong>职责分离原则 (SoD) 守卫：</strong> 您是该工单的申请人，根据企业合规规范，禁止审批自己发起的变更方案。
                    </span>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    onClick={() =>
                      setActiveAction({
                        runId: appr.run_id,
                        action: "request_changes",
                        title: "要求修改方案 (Request Changes)",
                      })
                    }
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-950/70 hover:bg-amber-900 border border-amber-800 text-amber-300 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>要求修改</span>
                  </button>

                  <button
                    onClick={() =>
                      setActiveAction({
                        runId: appr.run_id,
                        action: "reject",
                        title: "驳回工单 (Reject)",
                      })
                    }
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-950/70 hover:bg-rose-900 border border-rose-800 text-rose-300 transition-colors"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    <span>驳回</span>
                  </button>

                  <button
                    onClick={() =>
                      setActiveAction({
                        runId: appr.run_id,
                        action: "approve",
                        title: "批准通过 (Approve)",
                      })
                    }
                    disabled={isSelfCreated}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold text-white shadow-xs transition-all",
                      isSelfCreated
                        ? "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
                        : "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 glow-emerald"
                    )}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>批准通过</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action Dialog Modal */}
      {activeAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="glass-panel w-full max-w-md rounded-xl border border-slate-700 p-6 space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-100">{activeAction.title}</h3>
            <p className="text-xs text-slate-400">
              目标工单: <span className="font-mono text-emerald-400">{activeAction.runId}</span>
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">审批意见 / 备注意见</label>
              <textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="请输入详细评审意见..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setActiveAction(null)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (activeAction.action === "approve") {
                    approveMutation.mutate({ runId: activeAction.runId, comment });
                  } else {
                    rejectMutation.mutate({
                      runId: activeAction.runId,
                      action: activeAction.action,
                      comment,
                    });
                  }
                }}
                disabled={approveMutation.isPending || rejectMutation.isPending}
                className={cn(
                  "px-4 py-1.5 text-xs font-semibold text-white rounded-lg shadow-xs transition-colors",
                  activeAction.action === "approve" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"
                )}
              >
                {approveMutation.isPending || rejectMutation.isPending ? "提交中..." : "确认提交决策"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
