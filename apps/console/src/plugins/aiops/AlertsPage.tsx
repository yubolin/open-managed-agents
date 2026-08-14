// AIOps alert list — the alert-side view of the closed loop
// (docs/aiops-closed-loop.md). Console plugin page: self-contained data
// fetching via useApi, no OSS app-state coupling (plugins/registry.ts
// contract). Wire rows are the snake_case shape of GET /v1/aiops/alerts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCwIcon } from "lucide-react";
import { useApi } from "../../lib/api";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { FilterChip } from "../../components/FilterChip";
import { StatusPill } from "../../components/Badge";
import { Button } from "@/components/ui/button";

interface AiopsAlert {
  id: string;
  source: string;
  fingerprint: string;
  severity: "critical" | "warning" | "info";
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  starts_at: number;
  ends_at: number | null;
  dedup_count: number;
  last_seen_at: number;
  session_id: string | null;
  status: "new" | "dispatching" | "dispatched" | "error" | "deduped" | "resolved";
  error: string | null;
  created_at: number;
}

const SEVERITIES = ["critical", "warning", "info"] as const;
const STATUSES = ["new", "dispatching", "dispatched", "error", "deduped", "resolved"] as const;

// Severity doubles as the pill tone: critical → danger, warning → info,
// info → muted. Alerts are exactly the status-pill use case.
const SEVERITY_TONE = { critical: "errored", warning: "running", info: "idle" } as const;
const STATUS_TONE = {
  new: "idle",
  dispatching: "running",
  dispatched: "completed",
  error: "errored",
  deduped: "neutral",
  resolved: "completed",
} as const;

function OptionList({
  options,
  selected,
  onPick,
}: {
  options: readonly string[];
  selected: string | undefined;
  onPick: (v: string | undefined) => void;
}) {
  return (
    <div className="p-1 min-w-36">
      <button
        type="button"
        onClick={() => onPick(undefined)}
        className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-bg-surface ${
          !selected ? "text-brand font-medium" : "text-fg-muted"
        }`}
      >
        All
      </button>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onPick(opt)}
          className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-bg-surface ${
            selected === opt ? "text-brand font-medium" : "text-fg-muted"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export function AlertsPage() {
  const { api } = useApi();
  const [alerts, setAlerts] = useState<AiopsAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  // Destructure `run` before it goes into an effect dep array — the hook
  // returns a fresh object each render, but `run` itself is stable.
  const { run: loadRun, loading: loadLoading } = useAsyncAction(
    useCallback(
      async (sev?: string, st?: string) => {
        setLoading(true);
        try {
          const params = new URLSearchParams();
          if (sev) params.set("severity", sev);
          if (st) params.set("status", st);
          const qs = params.toString();
          const res = await api<{ data: AiopsAlert[] }>(
            `/v1/aiops/alerts${qs ? `?${qs}` : ""}`,
          );
          setAlerts(res.data);
        } catch {
          // api() already toasted; keep the table (possibly empty).
        }
        setLoading(false);
      },
      [api],
    ),
  );

  useEffect(() => {
    void loadRun(severity, status);
  }, [severity, status, loadRun]);

  const columns = useMemo<ColumnDef<AiopsAlert>[]>(
    () => [
      {
        id: "severity",
        accessorKey: "severity",
        header: "Severity",
        cell: ({ row }) => (
          <StatusPill status={SEVERITY_TONE[row.original.severity]} label={row.original.severity} />
        ),
        enableHiding: false,
        size: 104,
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Alert",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.name}</div>
            <div className="text-xs text-fg-subtle font-mono truncate max-w-72">
              {row.original.fingerprint}
              {row.original.annotations?.summary
                ? ` · ${row.original.annotations.summary}`
                : ""}
            </div>
          </>
        ),
        enableHiding: false,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="space-y-1">
            <StatusPill
              status={STATUS_TONE[row.original.status]}
              label={row.original.status}
            />
            {row.original.error && (
              <div
                className="text-xs text-danger truncate max-w-56"
                title={row.original.error}
              >
                {row.original.error}
              </div>
            )}
          </div>
        ),
      },
      {
        id: "dedup",
        accessorKey: "dedup_count",
        header: "Count",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs tabular-nums">
            ×{row.original.dedup_count}
          </span>
        ),
        size: 72,
      },
      {
        id: "session",
        accessorKey: "session_id",
        header: "Triage Session",
        cell: ({ row }) =>
          row.original.session_id ? (
            <Link
              to={`/sessions/${row.original.session_id}`}
              className="text-brand hover:underline text-xs font-mono"
            >
              {row.original.session_id}
            </Link>
          ) : (
            <span className="text-fg-subtle text-xs">—</span>
          ),
      },
      {
        id: "last_seen",
        accessorKey: "last_seen_at",
        header: "Last Seen",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {new Date(row.original.last_seen_at).toLocaleString()}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<AiopsAlert>
      title="Alerts"
      subtitle="Ingested alerts and their dispatch state through the AIOps closed loop"
      data={alerts}
      loading={loading}
      getRowId={(a) => a.id}
      emptyTitle="No alerts"
      emptySubtitle="Alerts ingested via POST /v1/aiops/alerts appear here as the loop dispatches them."
      columns={columns}
      filters={
        <>
          <FilterChip
            label="Severity"
            active={!!severity}
            display={severity}
            onClear={() => setSeverity(undefined)}
          >
            <OptionList
              options={SEVERITIES}
              selected={severity}
              onPick={setSeverity}
            />
          </FilterChip>
          <FilterChip
            label="Status"
            active={!!status}
            display={status}
            onClear={() => setStatus(undefined)}
          >
            <OptionList options={STATUSES} selected={status} onPick={setStatus} />
          </FilterChip>
        </>
      }
      headerActions={
        <Button
          variant="ghost"
          onClick={() => void loadRun(severity, status)}
          loading={loadLoading}
          loadingLabel="Refreshing…"
        >
          <RefreshCwIcon className="size-4" />
          Refresh
        </Button>
      }
    />
  );
}
