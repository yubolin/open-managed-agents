import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Stethoscope, Wrench, Sparkles, ArrowRight, X, AlertCircle } from "lucide-react";
import { operationsApi } from "../lib/api";
import { DynamicForm } from "../components/DynamicForm";
import { cn } from "../lib/utils";

export function CatalogPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  // Fetch templates
  const { data, isLoading } = useQuery({
    queryKey: ["workspace", "templates", selectedCategory],
    queryFn: () => operationsApi.getTemplates(selectedCategory),
  });

  // Fetch active template detail
  const { data: detailData, isLoading: isDetailLoading } = useQuery({
    queryKey: ["workspace", "template", activeTemplateId],
    queryFn: () => operationsApi.getTemplate(activeTemplateId!),
    enabled: !!activeTemplateId,
  });

  // Create Run Mutation
  const createMutation = useMutation({
    mutationFn: operationsApi.createRun,
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["workspace", "runs"] });
      setActiveTemplateId(null);
      navigate(`/runs/${res.run.id}`);
    },
  });

  const templates = data?.templates || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-emerald-400" />
            <span>服务目录 · 运维模板库</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            选择标准化运维场景模板，由 AI Agent 自动收集证据、规划变更方案并流转审批。
          </p>
        </div>

        {/* Category Filters */}
        <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800 self-start">
          <button
            onClick={() => setSelectedCategory(undefined)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedCategory === undefined ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "text-slate-400 hover:text-slate-200"
            )}
          >
            全部模板
          </button>
          <button
            onClick={() => setSelectedCategory("diagnostic")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedCategory === "diagnostic" ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <Stethoscope className="w-3.5 h-3.5" />
            故障诊断
          </button>
          <button
            onClick={() => setSelectedCategory("change_plan")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              selectedCategory === "change_plan" ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30" : "text-slate-400 hover:text-slate-200"
            )}
          >
            <Wrench className="w-3.5 h-3.5" />
            变更执行
          </button>
        </div>
      </div>

      {/* Template Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card rounded-xl p-5 h-44 animate-pulse bg-slate-900/40" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="glass-panel rounded-xl p-12 text-center border border-slate-800">
          <AlertCircle className="w-8 h-8 text-slate-500 mx-auto mb-2" />
          <div className="text-sm text-slate-400">暂无该分类下的可用服务模板</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {templates.map((tpl) => {
            const isDiag = tpl.category === "diagnostic";
            return (
              <div
                key={tpl.id}
                className="glass-card rounded-xl p-5 flex flex-col justify-between group cursor-pointer"
                onClick={() => setActiveTemplateId(tpl.id)}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border font-mono",
                        isDiag
                          ? "bg-cyan-950/60 text-cyan-300 border-cyan-800/60"
                          : "bg-indigo-950/60 text-indigo-300 border-indigo-800/60"
                      )}
                    >
                      {isDiag ? <Stethoscope className="w-3 h-3" /> : <Wrench className="w-3 h-3" />}
                      {tpl.category}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">v{tpl.version}</span>
                  </div>

                  <h3 className="text-sm font-bold text-slate-100 group-hover:text-emerald-400 transition-colors">
                    {tpl.name}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1.5 line-clamp-2 leading-relaxed">
                    {tpl.description || "标准化运维自动化执行模板"}
                  </p>
                </div>

                <div className="mt-5 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                  <span className="text-[11px] text-slate-500 font-mono">{tpl.code}</span>
                  <button className="flex items-center gap-1 text-xs font-semibold text-emerald-400 group-hover:translate-x-0.5 transition-transform">
                    <span>发起工单</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Run Modal / Drawer */}
      {activeTemplateId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="glass-panel w-full max-w-lg rounded-2xl border border-slate-700/80 p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-5">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <span>发起运维工单</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  模板: <span className="font-mono text-emerald-400">{detailData?.template.name}</span> (v{detailData?.template.version})
                </p>
              </div>
              <button
                onClick={() => setActiveTemplateId(null)}
                className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isDetailLoading ? (
              <div className="py-12 text-center text-xs text-slate-400 animate-pulse">
                加载模板表单配置中...
              </div>
            ) : detailData?.version ? (
              <div className="space-y-4">
                <DynamicForm
                  formSchema={detailData.version.form_schema}
                  uiSchema={detailData.version.ui_schema}
                  onSubmit={(values) => {
                    createMutation.mutate({
                      template_id: detailData.template.id,
                      template_version_id: detailData.version.id,
                      title: `${detailData.template.name} - ${new Date().toLocaleTimeString()}`,
                      input_parameters: values,
                      auto_submit: true,
                    });
                  }}
                  onCancel={() => setActiveTemplateId(null)}
                  isSubmitting={createMutation.isPending}
                  submitLabel="直接提交并发起规划"
                />
              </div>
            ) : (
              <div className="text-xs text-rose-400">无法获取模板详情</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
