import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ListOrdered, RefreshCw, ChevronRight, Clock, AlertCircle } from "lucide-react";
import { operationsApi } from "../lib/api";
import { StateBadge } from "../components/StateBadge";
import { formatDate, cn } from "../lib/utils";
import type { WorkspaceRunState } from "@open-managed-agents/api-types";

export function RunsPage() {
  const navigate = useNavigate();
  const [selectedState, setSelectedState] = useState<string | undefined>(undefined);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["workspace", "runs", selectedState],
    queryFn: () => operationsApi.getRuns({ state: selectedState }),
  });

  const runs = data?.runs || [];

  const filterTabs = [
    { label: "全部工单", state: undefined },
    { label: "规划中 (Planning)", state: "planning" },
    { label: "待审批 (Awaiting)", state: "awaiting_approval" },
    { label: "执行中 (Executing)", state: "executing" },
    { label: "已成功 (Succeeded)", state: "succeeded" },
    { label: "需关注 (Failed/Invalid)", state: "approval_invalidated" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ListOrdered className="w-5 h-5 text-indigo-400" />
            <span>工单看板 · 实时状态跟踪</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            全生命周期 13 态可视化跟踪，多级审批流转与沙箱自动执行监控。
          </p>
        </div>

        <button
          onClick={() => refetch()}
          disabled={isRefetching}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 transition-colors self-start"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isRefetching && "animate-spin text-emerald-400")} />
          <span>刷新数据</span>
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800 overflow-x-auto">
        {filterTabs.map((tab) => {
          const isActive = selectedState === tab.state;
          return (
            <button
              key={tab.label}
              onClick={() => setSelectedState(tab.state)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors",
                isActive
                  ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  : "text-slate-400 hover:text-slate-200"
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Runs Table / Cards */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="glass-panel rounded-xl p-4 h-20 animate-pulse bg-slate-900/40" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="glass-panel rounded-xl p-12 text-center border border-slate-800">
          <AlertCircle className="w-8 h-8 text-slate-500 mx-auto mb-2" />
          <div className="text-sm text-slate-400">暂无符合条件的运维工单</div>
        </div>
      ) : (
        <div className="glass-panel rounded-xl border border-slate-800/90 overflow-hidden divide-y divide-slate-800/80">
          {runs.map((run) => (
            <div
              key={run.id}
              onClick={() => navigate(`/runs/${run.id}`)}
              className="p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-900/60 cursor-pointer transition-colors group"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="font-mono text-xs font-semibold text-slate-400">{run.id}</span>
                  <span className="text-sm font-semibold text-slate-100 group-hover:text-emerald-400 transition-colors">
                    {run.title}
                  </span>
                  <StateBadge state={run.state as WorkspaceRunState} />
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400 font-sans">
                  <span>模板: <span className="font-mono text-slate-300">{run.template_name || run.service_template_id}</span></span>
                  <span>申请人: <span className="font-mono text-slate-300">{run.created_by}</span></span>
                  {run.current_approval_stage > 0 && (
                    <span>审批阶段: <span className="font-mono text-amber-400">Stage {run.current_approval_stage}</span></span>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-6 shrink-0">
                <div className="text-right">
                  <div className="text-xs text-slate-300 font-mono">{formatDate(run.updated_at)}</div>
                  <div className="text-[10px] text-slate-500 flex items-center gap-1 justify-end">
                    <Clock className="w-3 h-3" />
                    <span>创建于 {formatDate(run.created_at)}</span>
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-emerald-400 group-hover:translate-x-0.5 transition-all" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
