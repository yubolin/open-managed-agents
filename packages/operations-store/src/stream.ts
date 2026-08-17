// Operations Workspace StreamHub Port & In-Memory Implementation (Base C).
// Pure event fanout matrix (tenantId x runId). Zero state mutation authority.

import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";

export interface OperationsStreamHubPort {
  /**
   * Broadcast an event to all active subscribers of the given (tenantId, runId).
   * Best-effort non-blocking delivery.
   */
  publish(tenantId: string, runId: string, event: WorkspaceStreamEvent): void;

  /**
   * Subscribe to live events for a specific run under a tenant.
   * Returns an unsubscribe function.
   */
  subscribe(
    tenantId: string,
    runId: string,
    listener: (event: WorkspaceStreamEvent) => void
  ): () => void;

  /**
   * Get active subscriber count for telemetry/testing.
   */
  getSubscriberCount(tenantId: string, runId: string): number;
}

export class InMemoryOperationsStreamHub implements OperationsStreamHubPort {
  // Key format: `${tenantId}::${runId}`
  private readonly subscribers = new Map<string, Set<(event: WorkspaceStreamEvent) => void>>();

  publish(tenantId: string, runId: string, event: WorkspaceStreamEvent): void {
    const key = `${tenantId}::${runId}`;
    const listeners = this.subscribers.get(key);
    if (!listeners || listeners.size === 0) return;

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        // Drop slow or errored listeners safely (best-effort)
        listeners.delete(listener);
      }
    }
  }

  subscribe(
    tenantId: string,
    runId: string,
    listener: (event: WorkspaceStreamEvent) => void
  ): () => void {
    const key = `${tenantId}::${runId}`;
    let listeners = this.subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(key, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.subscribers.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  getSubscriberCount(tenantId: string, runId: string): number {
    const key = `${tenantId}::${runId}`;
    return this.subscribers.get(key)?.size ?? 0;
  }
}

// Global default singleton for in-process broadcast
export const globalOperationsStreamHub = new InMemoryOperationsStreamHub();
