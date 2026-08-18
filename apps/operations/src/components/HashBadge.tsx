import { useState } from "react";
import { ShieldCheck, Copy, Check } from "lucide-react";
import { shortHash, cn } from "../lib/utils";

interface HashBadgeProps {
  label: string;
  hash: string | null | undefined;
  className?: string;
}

export function HashBadge({ label, hash, className }: HashBadgeProps) {
  const [copied, setCopied] = useState(false);

  if (!hash) {
    return (
      <div className={cn("inline-flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-xs text-slate-500 font-mono", className)}>
        <span>{label}:</span>
        <span>未生成</span>
      </div>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      title={`完整 SHA-256: ${hash}`}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900/90 border border-emerald-500/30 text-xs font-mono text-emerald-400 group cursor-pointer hover:border-emerald-500/60 transition-colors",
        className
      )}
      onClick={handleCopy}
    >
      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
      <span className="text-slate-400 font-sans">{label}:</span>
      <span className="font-semibold">{shortHash(hash, 10)}</span>
      <button className="text-slate-500 group-hover:text-slate-300 ml-1">
        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}
