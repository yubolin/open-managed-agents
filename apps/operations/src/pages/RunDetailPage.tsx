import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Send,
  RotateCcw,
  Ban,
  Radio,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { operationsApi } from "../lib/api";
import { useRunStream } from "../lib/use-run-stream";
import { StateBadge } from "../components/StateBadge";
import { HashBadge } from "../components/HashBadge";
import { StateTimeline } from "../components/StateTimeline";
import { ApprovalPipeline } from "../components/ApprovalPipeline";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { EvidenceViewer } from "../components/EvidenceViewer";
import { formatDate } from "../lib/utils";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [isReworkModalOpen, setIsReworkModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [reworkComment, setReworkComment] = useState("");

  // SSE StreamHook (<2s SLA); status surfaces stale streams (one-time
  // tickets mean no auto-reconnect — F6 re-ticket contract pending)
  const { status: streamStatus } = useRunStream(id);

  // Fetch Run Detail
  const { data, isLoading } = useQuery({
    queryKey: ["workspace", "run", id],
    queryFn: () => operationsApi.getRun(id!),
    enabled: !!id,
  });

  // Fetch Artifacts
  const { data: artifactsData } = useQuery({
    queryKey: ["workspace", "artifacts", id],
    queryFn: () => operationsApi.getArtifacts(id!),
    enabled: !!id,
  });

  // Action Mutations
  const submitMutation = useMutation({
    mutationFn: () => operationsApi.submitRun(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace", "run", id] }),
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => operationsApi.cancelRun(id!, { reason }),
    onSuccess: () => {
      setIsCancelModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["workspace", "run", id] });
    },
  });

  const reworkMutation = useMutation({
    mutationFn: (comment: string) => operationsApi.reworkRun(id!, { comment }),
    onSuccess: () => {
      setIsReworkModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["workspace", "run", id] });
    },
  });

  if (isLoading || !data?.run) {
    return (
      <div className="py-16 text-center text-xs text-slate-400 animate-pulse">
        正在加载工单详情与实时状态...
      </div>
    );
  }

  const run = data.run;
  const artifacts = artifactsData?.artifacts || [];
  const planArtifact = artifacts.find((a) => a.type === "plan");
  const evidenceArtifact = artifacts.find((a) => a.type === "diagnosis_evidence");

  const canSubmit = run.state === "draft";
  const canCancel = ["draft", "submitted", "awaiting_approval"].includes(run.state);
  const canRework = ["changes_requested", "approval_invalidated"].includes(run.state);

  return (
    <div className="space-y-6">
      {/* Back Button & Top Meta */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/runs")}
            className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-slate-400">{run.id}</span>
              <h1 className="text-lg font-bold text-slate-100">{run.title}</h1>
              <StateBadge state={run.state as WorkspaceRunState} />
            </div>
            <div className="text-xs text-slate-400 flex items-center gap-3 mt-1">
              <span>申请人: <span className="font-mono text-slate-200">{run.created_by}</span></span>
              <span>创建时间: <span className="font-mono text-slate-200">{formatDate(run.created_at)}</span></span>
              {streamStatus === "connected" && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                  <Radio className="w-3 h-3 animate-pulse" />
                  SSE 实时监听中
                </span>
              )}
              {streamStatus === "disconnected" && (
                <span className="flex items-center gap-1 text-[11px] text-amber-400 font-mono">
                  <AlertTriangle className="w-3 h-3" />
                  实时连接已断开，数据可能已过期
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {canSubmit && (
            <button
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white glow-emerald shadow-xs transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{submitMutation.isPending ? "提交中..." : "正式提交"}</span>
            </button>
          )}

          {canRework && (
            <button
              onClick={() => setIsReworkModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white glow-amber shadow-xs transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>返工重提 (Rework)</span>
            </button>
          )}

          {canCancel && (
            <button
              onClick={() => setIsCancelModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-950/80 hover:bg-rose-900 border border-rose-800/80 text-rose-300 transition-colors"
            >
              <Ban className="w-3.5 h-3.5" />
              <span>取消工单</span>
            </button>
          )}
        </div>
      </div>

      {/* State Machine Timeline */}
      <StateTimeline state={run.state as WorkspaceRunState} />

      {/* Multi-Stage Approval Pipeline Timeline */}
      <ApprovalPipeline
        policy={data.approval_policy}
        currentStage={run.current_approval_stage}
        runState={run.state as WorkspaceRunState}
        approvals={data.approvals || []}
      />

      {/* Hash Fingerprints & Stage Meta */}
      <div className="glass-panel rounded-xl p-4 border border-slate-800/90 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-wrap">
          <HashBadge label="方案哈希 (plan_hash)" hash={run.plan_hash} />
          <HashBadge label="证据快照 (evidence_hash)" hash={run.evidence_snapshot_hash} />
        </div>

        {run.current_approval_stage > 0 && (
          <div className="text-xs font-mono text-amber-400 bg-amber-950/40 border border-amber-800/50 px-3 py-1 rounded-md">
            当前流转审批: Stage {run.current_approval_stage}
          </div>
        )}
      </div>

      {/* Failure Reason Alert */}
      {run.failure_reason && (
        <div className="glass-panel rounded-xl p-4 border border-rose-800/60 bg-rose-950/30 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <div className="font-semibold text-rose-300">异常/驳回原因</div>
            <pre className="font-mono text-rose-200 whitespace-pre-wrap">
              {typeof run.failure_reason === "object" ? JSON.stringify(run.failure_reason, null, 2) : String(run.failure_reason)}
            </pre>
          </div>
        </div>
      )}

      {/* Dual Column: Plan Markdown & Evidence Snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Plan */}
        <div className="glass-panel rounded-xl border border-slate-800 p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              <span>规划方案内容 (Plan Artifact)</span>
            </h2>
            {planArtifact && (
              <span className="text-[11px] font-mono text-slate-400">
                生成者: {planArtifact.created_by}
              </span>
            )}
          </div>
          <MarkdownViewer content={planArtifact?.content} />
        </div>

        {/* Right Column: Evidence */}
        <div className="space-y-4">
          <EvidenceViewer content={evidenceArtifact?.content} sha256={evidenceArtifact?.content_sha256} />
        </div>
      </div>

      {/* Cancel Modal */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="glass-panel w-full max-w-md rounded-xl border border-slate-700 p-6 space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-100">确认取消此运维工单？</h3>
            <p className="text-xs text-slate-400">取消后工单将进入终态 cancelled，不可再次流转。</p>
            <textarea
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="请输入取消原因（可选）..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-rose-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsCancelModalOpen(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => cancelMutation.mutate(cancelReason)}
                disabled={cancelMutation.isPending}
                className="px-4 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg"
              >
                {cancelMutation.isPending ? "取消中..." : "确认取消"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rework Modal */}
      {isReworkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="glass-panel w-full max-w-md rounded-xl border border-slate-700 p-6 space-y-4 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-100">申请人返工重提 (Rework)</h3>
            <p className="text-xs text-slate-400">
              返工将重置审批阶段至 Stage 1，并重新触发 Agent 进行方案规划。
            </p>
            <textarea
              rows={3}
              value={reworkComment}
              onChange={(e) => setReworkComment(e.target.value)}
              placeholder="说明修改要点或补充信息..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-amber-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsReworkModalOpen(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => reworkMutation.mutate(reworkComment)}
                disabled={reworkMutation.isPending}
                className="px-4 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg glow-amber"
              >
                {reworkMutation.isPending ? "重提中..." : "重新发起规划"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
