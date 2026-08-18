// Cloudflare Durable Object StreamHub Adapter for Operations Workspace (F3 P2-②).
// Publishes events to the per-(tenantId, runId) OperationsStreamRoom DO broadcast anchor.

import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";
import type { OperationsStreamHubPort } from "../stream";

/**
 * Structural slice of the DurableObjectNamespace this adapter touches —
 * the real namespace binding satisfies it structurally, while tests can
 * still inject a narrowed fake.
 */
export type CfOperationsStreamRoomNamespace = Pick<
  DurableObjectNamespace,
  "idFromName" | "get"
>;

export class CfOperationsStreamHub implements OperationsStreamHubPort {
  constructor(
    private readonly namespace?: CfOperationsStreamRoomNamespace,
    /**
     * H-1: extends the request's event context over the in-flight DO
     * publish. Workers may cancel outstanding subrequests once the handler
     * returns — without this, fire-and-forget publishes are Schrödinger
     * frames (delivered only if the isolate stays warm long enough).
     * Injected from servicesMiddleware via c.executionCtx.waitUntil.
     */
    private readonly waitUntil?: (p: Promise<unknown>) => void,
  ) {}

  publish(tenantId: string, runId: string, event: WorkspaceStreamEvent): void {
    if (!this.namespace) return;
    try {
      const id = this.namespace.idFromName(`${tenantId}::${runId}`);
      const stub = this.namespace.get(id);
      const sent = stub
        .fetch("https://operations-stream-room/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event }),
        })
        .catch(() => {
          // Best-effort delivery: broadcast failures never fail transactions
        });
      if (this.waitUntil) {
        this.waitUntil(sent);
      } else {
        void sent;
      }
    } catch {
      // Best-effort delivery
    }
  }

  subscribe(_tenantId: string, _runId: string, _listener: (event: WorkspaceStreamEvent) => void): () => void {
    // In CF environment, SSE connections are held directly in OperationsStreamRoom DO.
    return () => {};
  }

  getSubscriberCount(_tenantId: string, _runId: string): number {
    return 0;
  }
}
