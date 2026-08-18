import {
  CheckCircle2,
  Clock,
  Users,
  ShieldCheck,
  Cpu,
  XCircle,
  RotateCcw,
  ArrowRight,
  UserCheck,
} from "lucide-react";
import type {
  WorkspaceApprovalPolicyDto,
  WorkspaceApprovalRecordDto,
  WorkspaceApprovalStageItem,
  WorkspaceRunState,
} from "@open-managed-agents/api-types";
import { formatDate } from "../lib/utils";

interface ApprovalPipelineProps {
  policy?: WorkspaceApprovalPolicyDto | null;
  currentStage: number;
  runState: WorkspaceRunState;
  approvals?: WorkspaceApprovalRecordDto[];
}

export function ApprovalPipeline({
  policy,
  currentStage,
  runState,
  approvals = [],
}: ApprovalPipelineProps) {
  // Default single-stage fallback if policy is absent
  const stages: WorkspaceApprovalStageItem[] = policy?.stages?.length
    ? policy.stages
    : [
        {
          stage_order: 1,
          stage_name: "默认审批组",
          group_id: "grp_default",
          required_approvals: 1,
        },
      ];

  const totalStages = stages.length;

  return (
    <div className="glass-panel rounded-xl p-5 border border-slate-800/90 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-bold text-slate-100">
            多级审批流节点全景 (Approval Route Pipeline)
          </h2>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
          <span>总审批级数: {totalStages} 级</span>
          <span>•</span>
          <span className="text-indigo-300">
            模式: {policy?.mode === "sequential_groups" ? "串行分组审批 (Sequential)" : "标准审批"}
          </span>
        </div>
      </div>

      {/* Pipeline Stepper Nodes */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 relative">
        {stages.map((stage, idx) => {
          const isPassed =
            stage.stage_order < currentStage ||
            (stage.stage_order === currentStage &&
              (runState === "approved" ||
                runState === "executing" ||
                runState === "succeeded"));

          const isCurrent =
            stage.stage_order === currentStage &&
            runState === "awaiting_approval";

          const isNext =
            stage.stage_order === currentStage + 1 &&
            runState === "awaiting_approval";

          const isFuture = stage.stage_order > currentStage + 1;

          const isRejected =
            stage.stage_order === currentStage &&
            (runState === "rejected" || runState === "changes_requested");

          // Find historical approval record for this stage
          const stageApproval = approvals.find(
            (a) => a.stage_order === stage.stage_order && !((a as any).is_invalidated),
          );

          return (
            <div
              key={stage.stage_order}
              className={`rounded-xl p-4 border transition-all relative flex flex-col justify-between ${
                isCurrent
                  ? "bg-amber-950/20 border-amber-500/50 glow-amber ring-1 ring-amber-500/30"
                  : isPassed
                  ? "bg-emerald-950/15 border-emerald-800/60 glow-emerald"
                  : isNext
                  ? "bg-indigo-950/20 border-indigo-700/50"
                  : isRejected
                  ? "bg-rose-950/20 border-rose-800/60"
                  : "bg-slate-900/40 border-slate-800/70 opacity-70"
              }`}
            >
              {/* Card Header */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-slate-400">
                    STAGE {stage.stage_order}
                  </span>
                  {isPassed && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-950/80 border border-emerald-800/80 px-2 py-0.5 rounded-md font-mono">
                      <CheckCircle2 className="w-3 h-3" />
                      已通过
                    </span>
                  )}
                  {isCurrent && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-300 bg-amber-950/90 border border-amber-700/80 px-2 py-0.5 rounded-md font-mono animate-pulse">
                      <Clock className="w-3 h-3" />
                      当前审批中
                    </span>
                  )}
                  {isNext && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-300 bg-indigo-950/80 border border-indigo-800 px-2 py-0.5 rounded-md font-mono">
                      <ArrowRight className="w-3 h-3" />
                      下一节点
                    </span>
                  )}
                  {isFuture && (
                    <span className="text-[11px] text-slate-500 bg-slate-800/60 border border-slate-700/50 px-2 py-0.5 rounded-md font-mono">
                      待流转
                    </span>
                  )}
                  {isRejected && (
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-rose-400 bg-rose-950/80 border border-rose-800 px-2 py-0.5 rounded-md font-mono">
                      <XCircle className="w-3 h-3" />
                      {runState === "rejected" ? "已驳回" : "要求修改"}
                    </span>
                  )}
                </div>

                <div className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                  <span>{stage.stage_name}</span>
                </div>
              </div>

              {/* Card Body / Assignee Details */}
              <div className="mt-3 pt-2.5 border-t border-slate-800/60 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="flex items-center gap-1 text-slate-400">
                    <Users className="w-3 h-3 text-slate-400" />
                    指定责任组:
                  </span>
                  <span className="font-mono text-slate-200 font-semibold">
                    {stage.group_id}
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-400">
                  <span>签署门槛:</span>
                  <span className="font-mono text-slate-300">
                    {stage.required_approvals} 人通过生效
                  </span>
                </div>

                {/* Historical sign-off info if passed */}
                {stageApproval && (
                  <div className="mt-2 pt-2 border-t border-emerald-900/50 text-[11px] text-emerald-300/90 space-y-1 bg-emerald-950/30 p-2 rounded-lg">
                    <div className="flex items-center gap-1 font-mono">
                      <UserCheck className="w-3 h-3 text-emerald-400" />
                      <span>签署人: {stageApproval.approver_id}</span>
                    </div>
                    <div className="text-slate-400 text-[10px] font-mono">
                      时间: {formatDate(stageApproval.created_at)}
                    </div>
                    {stageApproval.comment && (
                      <div className="text-slate-300 italic text-[11px]">
                        "{stageApproval.comment}"
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Final Execution Node */}
        <div
          className={`rounded-xl p-4 border transition-all flex flex-col justify-between ${
            runState === "succeeded"
              ? "bg-emerald-950/20 border-emerald-600/70 glow-emerald"
              : runState === "executing" || runState === "approved"
              ? "bg-indigo-950/20 border-indigo-500/60 glow-emerald animate-pulse"
              : "bg-slate-900/30 border-slate-800/50 opacity-60"
          }`}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-bold text-slate-400">
                EXECUTION
              </span>
              {runState === "succeeded" && (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-950/80 border border-emerald-800 px-2 py-0.5 rounded-md font-mono">
                  <CheckCircle2 className="w-3 h-3" />
                  执行完毕
                </span>
              )}
              {(runState === "executing" || runState === "approved") && (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-300 bg-indigo-950/80 border border-indigo-700 px-2 py-0.5 rounded-md font-mono">
                  <Cpu className="w-3 h-3" />
                  沙箱执行中
                </span>
              )}
              {runState !== "succeeded" &&
                runState !== "executing" &&
                runState !== "approved" && (
                  <span className="text-[11px] text-slate-500 bg-slate-800/50 border border-slate-700/40 px-2 py-0.5 rounded-md font-mono">
                    待点火
                  </span>
                )}
            </div>

            <div className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>沙箱自主运维执行</span>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800/60 text-xs text-slate-400">
            {runState === "succeeded" ? (
              <span className="text-emerald-300">自动化诊断与修复已完成并归档。</span>
            ) : runState === "executing" ? (
              <span className="text-cyan-300 animate-pulse">沙箱正按方案哈希执行脚本...</span>
            ) : (
              <span>前置所有审批节点签署完毕后自动点火。</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
