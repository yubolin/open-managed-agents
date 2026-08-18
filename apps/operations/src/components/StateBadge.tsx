import type { WorkspaceRunState } from "@open-managed-agents/api-types";
import { getStateMeta, cn } from "../lib/utils";

interface StateBadgeProps {
  state: WorkspaceRunState;
  className?: string;
  showDot?: boolean;
}

export function StateBadge({ state, className, showDot = true }: StateBadgeProps) {
  const meta = getStateMeta(state);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border shadow-xs transition-colors",
        meta.badgeClass,
        className
      )}
    >
      {showDot && (
        <span className="relative flex h-2 w-2">
          <span className={cn("relative inline-flex rounded-full h-2 w-2", meta.dotClass)} />
        </span>
      )}
      {meta.label}
    </span>
  );
}
