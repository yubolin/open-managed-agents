// SSE Real-Time Stream Hook for Operations Workspace (Base D)
// Manages 30s Ticket lifecycle, EventSource connection, event dispatching,
// and cache invalidation. Reconnect is deliberately NOT attempted here:
// tickets are single-use, so a naive EventSource auto-reconnect would 401
// forever with the consumed token (debt F6 — re-ticket contract pending).

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { operationsApi } from "./api";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

export type RunStreamStatus = "connecting" | "connected" | "disconnected";

export function useRunStream(runId: string | undefined) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RunStreamStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<WorkspaceStreamEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;

    let isMounted = true;

    async function connect() {
      try {
        // 1. Get single-use 30s ticket bound to runId
        const { ticket } = await operationsApi.createAuthTicket({ run_id: runId });
        if (!isMounted) return;

        // 2. Open EventSource stream
        const es = new EventSource(`/v1/workspace/runs/${runId}/events/stream?token=${ticket}`);
        esRef.current = es;

        es.onopen = () => {
          if (isMounted) setStatus("connected");
        };

        // Standard event listeners
        const handleEvent = (e: MessageEvent) => {
          try {
            const ev = JSON.parse(e.data) as WorkspaceStreamEvent;
            if (isMounted) {
              setLastEvent(ev);
              // Invalidate run queries
              queryClient.invalidateQueries({ queryKey: ["workspace", "run", runId] });
              queryClient.invalidateQueries({ queryKey: ["workspace", "runs"] });
              if (ev.event_type === "run.artifact_created") {
                queryClient.invalidateQueries({ queryKey: ["workspace", "artifacts", runId] });
              }
              if (ev.event_type.startsWith("run.approval")) {
                queryClient.invalidateQueries({ queryKey: ["workspace", "approvals"] });
              }
            }
          } catch {
            // Ignore parse error
          }
        };

        es.addEventListener("connected", () => {
          if (isMounted) setStatus("connected");
        });

        es.addEventListener("run.state_changed", handleEvent as EventListener);
        es.addEventListener("run.artifact_created", handleEvent as EventListener);
        es.addEventListener("run.approval_requested", handleEvent as EventListener);
        es.addEventListener("run.approval_decided", handleEvent as EventListener);
        es.addEventListener("run.cancelled", handleEvent as EventListener);
        es.addEventListener("run.interrupted", handleEvent as EventListener);

        es.onerror = () => {
          if (isMounted) {
            // One-time ticket is spent: native reconnect would 401-loop, so
            // close and surface the stale state instead (F6 owns re-ticket).
            setStatus("disconnected");
            es.close();
          }
        };
      } catch (err) {
        if (isMounted) setStatus("disconnected");
      }
    }

    connect();

    return () => {
      isMounted = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [runId, queryClient]);

  return { status, isConnected: status === "connected", lastEvent };
}
