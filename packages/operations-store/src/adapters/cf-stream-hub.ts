// Cloudflare Durable Object StreamHub Adapter for Operations Workspace (F3 P2-②).
// Publishes events to the per-(tenantId, runId) OperationsStreamRoom DO broadcast anchor.

import type { WorkspaceStreamEvent } from "@open-managed-agents/api-types";
import type { OperationsStreamHubPort } from "../stream";

export interface CfOperationsStreamRoomNamespace {
  idFromName(name: string): any;
  get(id: any): {
    fetch(url: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
}

export class CfOperationsStreamHub implements OperationsStreamHubPort {
  constructor(private readonly namespace?: CfOperationsStreamRoomNamespace) {}

  publish(tenantId: string, runId: string, event: WorkspaceStreamEvent): void {
    if (!this.namespace) return;
    try {
      const id = this.namespace.idFromName(`${tenantId}::${runId}`);
      const stub = this.namespace.get(id);
      // Best-effort fire-and-forget publish to DO room
      void stub
        .fetch("https://operations-stream-room/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event }),
        })
        .catch(() => {
          // Best-effort delivery: broadcast failures never fail transactions
        });
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
