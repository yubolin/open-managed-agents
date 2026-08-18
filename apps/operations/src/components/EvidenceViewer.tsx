import { useState } from "react";
import { Activity } from "lucide-react";
import { cn, shortHash } from "../lib/utils";

interface EvidenceViewerProps {
  content: string | null | undefined;
  sha256?: string | null;
  className?: string;
}

export function EvidenceViewer({ content, sha256, className }: EvidenceViewerProps) {
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");

  if (!content) {
    return (
      <div className="p-6 text-center text-xs text-slate-500 bg-slate-900/30 rounded-xl border border-dashed border-slate-800">
        暂无诊断证据快照
      </div>
    );
  }

  let parsed: Record<string, any> | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Plain text content
  }

  return (
    <div className={cn("glass-panel rounded-xl border border-slate-800 overflow-hidden", className)}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/80 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span className="text-xs font-semibold text-slate-200">现场诊断证据快照 (Snapshot)</span>
          {sha256 && (
            <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/50 border border-cyan-800/60 px-1.5 py-0.5 rounded" title={sha256}>
              {shortHash(sha256, 8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setViewMode("formatted")}
            className={cn(
              "px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors",
              viewMode === "formatted" ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"
            )}
          >
            可视化
          </button>
          <button
            onClick={() => setViewMode("raw")}
            className={cn(
              "px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors",
              viewMode === "raw" ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"
            )}
          >
            JSON 源码
          </button>
        </div>
      </div>

      <div className="p-4 max-h-96 overflow-y-auto font-mono text-xs">
        {viewMode === "raw" || !parsed ? (
          <pre className="text-slate-300 whitespace-pre-wrap">{content}</pre>
        ) : (
          <div className="space-y-3 font-sans">
            {Object.entries(parsed).map(([key, val]) => (
              <div key={key} className="bg-slate-900/60 p-3 rounded-lg border border-slate-800/80">
                <div className="text-[11px] font-mono text-cyan-400 mb-1">{key}</div>
                <div className="text-xs text-slate-200 font-mono">
                  {typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
