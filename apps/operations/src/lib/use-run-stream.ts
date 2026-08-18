// SSE Real-Time Stream Hook for Operations Workspace (Base D + F6).
// Manages single-use ticket lifecycle, EventSource connection, event dispatching,
// cache invalidation, and exponential-backoff reconnection with re-ticketing (F6).
//
// Reconnection contract (F6):
//   1. Because tickets are single-use (DELETE ... RETURNING), native EventSource
//      auto-reconnection would 401 forever with the burned ticket.
//   2. On onerror / disconnect, the client immediately closes the dead EventSource.
//   3. Status flips to "reconnecting", and an exponential backoff timer is scheduled
//      (1s -> 2s -> 4s -> 8s -> max 15s + jitter).
//   4. When the timer fires, the client mints a FRESH single-use ticket via
//      POST /auth/ticket, opens a new EventSource, and on reconnect invalidates
//      React Query cache so any missed state transitions catch up from REST SoT.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { operationsApi } from "./api";
import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

export type RunStreamStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface UseRunStreamOptions {
  /** Maximum backoff delay in ms (default: 15,000ms). */
  maxBackoffMs?: number;
  /** Disable automatic reconnection if false (default: true). */
  autoReconnect?: boolean;
}

export function useRunStream(runId: string | undefined, options: UseRunStreamOptions = {}) {
  const { maxBackoffMs = 15_000, autoReconnect = true } = options;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RunStreamStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<WorkspaceStreamEvent | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    if (!runId) return;

    let isMounted = true;
    attemptRef.current = 0;
    wasConnectedRef.current = false;

    function cleanup() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    }

    async function scheduleReconnect() {
      if (!isMounted || !autoReconnect) {
        if (isMounted) setStatus("disconnected");
        return;
      }

      setStatus("reconnecting");
      attemptRef.current++;
      const baseDelay = Math.min(1000 * Math.pow(2, attemptRef.current - 1), maxBackoffMs);
      const jitter = Math.floor(Math.random() * 300);
      const delay = baseDelay + jitter;

      reconnectTimerRef.current = setTimeout(() => {
        if (isMounted) {
          void connect();
        }
      }, delay);
    }

    async function connect() {
      cleanup();

      try {
        // 1. Mint a fresh single-use ticket bound to runId (F6 contract)
        const { ticket } = await operationsApi.createAuthTicket({ run_id: runId });
        if (!isMounted) return;

        // 2. Open EventSource stream with the fresh ticket
        const es = new EventSource(`/v1/workspace/runs/${runId}/events/stream?token=${ticket}`);
        esRef.current = es;

        const onConnected = () => {
          if (!isMounted) return;
          setStatus("connected");
          const isReconnecting = wasConnectedRef.current || attemptRef.current > 0;
          attemptRef.current = 0;
          wasConnectedRef.current = true;

          // Catch-up: when reconnecting, invalidate queries to fetch latest REST SoT
          if (isReconnecting) {
            queryClient.invalidateQueries({ queryKey: ["workspace", "run", runId] });
            queryClient.invalidateQueries({ queryKey: ["workspace", "runs"] });
            queryClient.invalidateQueries({ queryKey: ["workspace", "artifacts", runId] });
            queryClient.invalidateQueries({ queryKey: ["workspace", "approvals"] });
          }
        };

        es.onopen = onConnected;

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

        es.addEventListener("connected", onConnected);
        es.addEventListener("run.state_changed", handleEvent as EventListener);
        es.addEventListener("run.artifact_created", handleEvent as EventListener);
        es.addEventListener("run.approval_requested", handleEvent as EventListener);
        es.addEventListener("run.approval_decided", handleEvent as EventListener);
        es.addEventListener("run.cancelled", handleEvent as EventListener);
        es.addEventListener("run.interrupted", handleEvent as EventListener);
        es.addEventListener("run.escalation", handleEvent as EventListener);

        es.onerror = () => {
          if (!isMounted) return;
          // Close dead EventSource immediately to prevent native 401 loop
          cleanup();
          void scheduleReconnect();
        };
      } catch {
        if (!isMounted) return;
        cleanup();
        void scheduleReconnect();
      }
    }

    void connect();

    return () => {
      isMounted = false;
      cleanup();
    };
  }, [runId, queryClient, autoReconnect, maxBackoffMs]);

  return { status, isConnected: status === "connected", lastEvent };
}
