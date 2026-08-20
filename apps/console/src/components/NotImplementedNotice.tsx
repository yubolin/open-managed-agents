/**
 * Inline notice rendered by pages whose list API answered 501 — the
 * runtime (e.g. a self-hosted Node deployment) doesn't implement the
 * feature. Replaces the empty-list state so the page never claims
 * "no data" when the truth is "no implementation"
 * (runtime-capabilities.md §4).
 */

interface NotImplementedNoticeProps {
  /** Server-provided detail line (the 501 body's error message). */
  detail?: string;
}

export function NotImplementedNotice({ detail }: NotImplementedNoticeProps) {
  return (
    <div
      className="mx-auto max-w-xl rounded-lg border border-warning/40 bg-warning/5 px-4 py-6 text-center"
      data-testid="not-implemented-notice"
    >
      <div className="text-sm font-medium text-fg">
        This feature is not implemented on the current runtime.
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        Contact your administrator if you need it here.
      </div>
      {detail && (
        <div className="mt-3 font-mono text-[11px] text-fg-subtle break-words">
          {detail}
        </div>
      )}
    </div>
  );
}
