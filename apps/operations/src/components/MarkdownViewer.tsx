import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";

interface MarkdownViewerProps {
  content: string | null | undefined;
  className?: string;
}

export function MarkdownViewer({ content, className }: MarkdownViewerProps) {
  if (!content) {
    return (
      <div className="p-6 text-center text-xs text-slate-500 bg-slate-900/30 rounded-xl border border-dashed border-slate-800">
        暂无方案内容
      </div>
    );
  }

  return (
    <div className={cn("prose prose-invert prose-emerald max-w-none text-xs leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
