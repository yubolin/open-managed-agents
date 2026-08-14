// AIOps approval queue — the human side of the 审批门禁
// (docs/aiops-closed-loop.md §审批门禁). Agents create requests; only a
// logged-in human (session-cookie auth) decides here. Deciding appends the
// continuation message to the triage session, which then executes (or stands
// down) and writes back to ITSM. Console plugin page: self-contained via
// useApi per the plugins/registry.ts contract.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCwIcon } from "lucide-react";
import { useApi } from "../../lib/api";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { FilterChip } from "../../components/FilterChip";
import { StatusPill } from "../../components/Badge";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";

interface ApprovalAction {
  kind: string;
  runbook_id?: string;
  params?: Record<string, unknown>;
  summary?: string;
}

interface Approval {
  id: string;
  session_id: string;
  alert_id: string | null;
  action: ApprovalAction;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_by: string;
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number;
  reason: string | null;
  created_at: number;
}

const STATUSES = ["pending", "approved", "rejected", "expired"] as const;

const STATUS_TONE = {
  pending: "running",
  approved: "completed",
  rejected: "errored",
  expired: "neutral",
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

export function ApprovalsPage() {
  const { api } = useApi();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | undefined>("pending");
  const [rejecting, setRejecting] = useState<Approval | null>(null);
  const [reason, setReason] = useState("");
  const [deciding, setDeciding] = useState<string | null>(null);

  // Destructure `run` before it goes into an effect dep array — the hook
  // returns a fresh object each render, but `run` itself is stable.
  const { run: loadRun, loading: loadLoading } = useAsyncAction(
    useCallback(
      async (st?: string) => {
        setLoading(true);
        try {
          const res = await api<{ data: Approval[] }>(
            `/v1/aiops/approvals${st ? `?status=${st}` : ""}`,
          );
          setApprovals(res.data);
        } catch {
          // api() already toasted.
        }
        setLoading(false);
      },
      [api],
    ),
  );

  useEffect(() => {
    void loadRun(status);
  }, [status, loadRun]);

  // Decides via POST /v1/aiops/approvals/:id/decide. Server-side gates
  // (human-only, not-yet-decided, unexpired) are authoritative — a 403/409
  // here lands in `message` and is surfaced inline.
  const { run: decideRun, loading: decideLoading } = useAsyncAction(
    useCallback(
      async (approval: Approval, decision: "approve" | "reject", withReason?: string) => {
        setDeciding(approval.id);
        try {
          await api(`/v1/aiops/approvals/${approval.id}/decide`, {
            method: "POST",
            body: JSON.stringify({
              decision,
              ...(withReason ? { reason: withReason } : {}),
            }),
          });
          setRejecting(null);
          setReason("");
          await loadRun(status);
        } catch {
          // api() already toasted the server message (403 non-human /
          // 409 already-decided etc.).
        }
        setDeciding(null);
      },
      [api, loadRun, status],
    ),
  );

  const columns = useMemo<ColumnDef<Approval>[]>(
    () => [
      {
        id: "action",
        accessorKey: "action",
        header: "Requested Action",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">
              {row.original.action.summary ?? row.original.action.kind}
            </div>
            <div className="text-xs text-fg-subtle font-mono truncate max-w-72">
              {row.original.action.runbook_id ?? row.original.action.kind}
              {row.original.action.params
                ? ` ${JSON.stringify(row.original.action.params)}`
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
            {row.original.reason && (
              <div
                className="text-xs text-fg-muted truncate max-w-48"
                title={row.original.reason}
              >
                {row.original.reason}
              </div>
            )}
          </div>
        ),
        enableHiding: false,
      },
      {
        id: "decided_by",
        accessorKey: "decided_by",
        header: "Decided By",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {row.original.decided_by ?? "—"}
          </span>
        ),
      },
      {
        id: "session",
        accessorKey: "session_id",
        header: "Triage Session",
        cell: ({ row }) => (
          <Link
            to={`/sessions/${row.original.session_id}`}
            className="text-brand hover:underline text-xs font-mono"
          >
            {row.original.session_id}
          </Link>
        ),
      },
      {
        id: "expires",
        accessorKey: "expires_at",
        header: "Expires",
        cell: ({ row }) => {
          const expired = row.original.expires_at < Date.now();
          return (
            <span
              className={`text-xs ${expired ? "text-danger" : "text-fg-muted"}`}
            >
              {new Date(row.original.expires_at).toLocaleString()}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          row.original.status === "pending" ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void decideRun(row.original, "approve")}
                loading={deciding === row.original.id && decideLoading}
                loadingLabel="…"
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setReason("");
                  setRejecting(row.original);
                }}
              >
                Reject
              </Button>
            </div>
          ) : null,
        enableHiding: false,
        size: 200,
      },
    ],
    [decideRun, deciding, decideLoading],
  );

  return (
    <DataTable<Approval>
      title="Approvals"
      subtitle="Human gate for AIOps automation — decisions continue the triage session and are written back to ITSM"
      data={approvals}
      loading={loading}
      getRowId={(a) => a.id}
      emptyTitle="Nothing awaiting approval"
      emptySubtitle="When a digital employee proposes an automation action, the approval request appears here."
      columns={columns}
      filters={
        <FilterChip
          label="Status"
          active={!!status}
          display={status}
          onClear={() => setStatus(undefined)}
        >
          <OptionList options={STATUSES} selected={status} onPick={setStatus} />
        </FilterChip>
      }
      headerActions={
        <Button
          variant="ghost"
          onClick={() => void loadRun(status)}
          loading={loadLoading}
          loadingLabel="Refreshing…"
        >
          <RefreshCwIcon className="size-4" />
          Refresh
        </Button>
      }
    >
      <Modal
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject Automation Request"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setRejecting(null)}
              disabled={decideLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void decideRun(rejecting!, "reject", reason || undefined)
              }
              loading={decideLoading}
              loadingLabel="Rejecting…"
            >
              Reject
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-sm text-fg-muted">
            {rejecting?.action.summary ?? rejecting?.action.kind} — the triage
            session will be told to stand down and write the refusal back to
            ITSM.
          </div>
          <div>
            <label
              htmlFor="aiops-reject-reason"
              className="text-sm text-fg-muted block mb-1"
            >
              Reason (optional, shown to the agent)
            </label>
            <input
              id="aiops-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
              placeholder="e.g. change window not reached"
            />
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}
