import type { ComponentType } from "react";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";
import { CheckCircle2, Clock, PlayCircle, AlertCircle, FileText } from "lucide-react";
import { cn } from "../lib/utils";

interface StateTimelineProps {
  state: WorkspaceRunState;
  className?: string;
}

interface Step {
  id: string;
  title: string;
  desc: string;
  states: WorkspaceRunState[];
  icon: ComponentType<{ className?: string }>;
}

const STEPS: Step[] = [
  { id: "submit", title: "1. 发起提交", desc: "工单创建并提交", states: ["draft", "submitted"], icon: FileText },
  { id: "planning", title: "2. 方案规划", desc: "Agent 诊断与生成", states: ["planning"], icon: Clock },
  { id: "approval", title: "3. 审批决策", desc: "多级 SoD 与哈希防篡改", states: ["awaiting_approval", "approved", "changes_requested", "approval_invalidated", "rejected"], icon: AlertCircle },
  { id: "executing", title: "4. 自动执行", desc: "沙箱运维执行", states: ["executing"], icon: PlayCircle },
  { id: "finished", title: "5. 终态结项", desc: "结果归档与审计", states: ["succeeded", "failed", "cancelled", "interrupted"], icon: CheckCircle2 },
];

export function StateTimeline({ state, className }: StateTimelineProps) {
  // Determine active step index
  if (state === "draft" || state === "submitted") activeIndex = 0;
  else if (state === "planning") activeIndex = 1;
  else if (["awaiting_approval", "changes_requested", "approval_invalidated", "rejected"].includes(state)) activeIndex = 2;
  else if (state === "approved" || state === "executing") activeIndex = 3;
  else if (["succeeded", "failed", "cancelled", "interrupted"].includes(state)) activeIndex = 4;

  const isFailed = ["failed", "rejected", "approval_invalidated", "cancelled", "interrupted"].includes(state);

  return (
    <div className={cn("glass-panel rounded-xl p-4 sm:p-5 border border-slate-800", className)}>
      <div className="flex items-center justify-between relative">
        {/* Background Connecting Line */}
        <div className="absolute top-1/2 left-6 right-6 -translate-y-1/2 h-0.5 bg-slate-800 -z-0" />
        
        {STEPS.map((step, idx) => {
          const isCurrent = idx === activeIndex;
          const isPast = idx < activeIndex;
          const isFuture = idx > activeIndex;

          const StepIcon = step.icon;

          return (
            <div key={step.id} className="relative z-10 flex flex-col items-center flex-1">
              <div
                className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all",
                  isPast && "bg-emerald-950 border-emerald-500 text-emerald-400",
                  isCurrent && !isFailed && "bg-indigo-950 border-indigo-400 text-indigo-300 ring-4 ring-indigo-500/20 animate-pulse",
                  isCurrent && isFailed && "bg-rose-950 border-rose-500 text-rose-300 ring-4 ring-rose-500/20",
                  isFuture && "bg-slate-900 border-slate-700 text-slate-500"
                )}
              >
                {isPast ? <CheckCircle2 className="w-5 h-5" /> : <StepIcon className="w-5 h-5" />}
              </div>
              <div className="mt-2 text-center">
                <div className={cn("text-xs font-semibold", isCurrent ? "text-slate-100 font-bold" : isPast ? "text-slate-300" : "text-slate-500")}>
                  {step.title}
                </div>
                <div className="text-[10px] text-slate-500 hidden sm:block">{step.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
