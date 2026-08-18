// @vitest-environment happy-dom
// Base D review D3 + F6: REAL coverage of useRunStream — tests the hook
// lifecycle, event dispatching, query invalidation, and F6 re-ticketing reconnect contract.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useRunStream } from "../src/lib/use-run-stream";
import { operationsApi } from "../src/lib/api";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) {
      l({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
  }
}

describe("useRunStream · real hook coverage & F6 reconnection contract", () => {
  const originalEventSource = (globalThis as any).EventSource;
  let ticketCounter = 0;

  beforeEach(() => {
    ticketCounter = 0;
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
    vi.spyOn(operationsApi, "createAuthTicket").mockImplementation(async ({ run_id }) => {
      ticketCounter++;
      return {
        ticket: `tkt_hook_${run_id}_${ticketCounter}`,
        expires_in_seconds: 30,
      };
    });
  });

  afterEach(() => {
    (globalThis as any).EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  function createWrapper(client: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    };
  }

  it("1. Handshake: acquires run-bound ticket first, then opens EventSource with token URL", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useRunStream("run_hook_1"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });

    expect(operationsApi.createAuthTicket).toHaveBeenCalledWith({ run_id: "run_hook_1" });
    expect(MockEventSource.instances[0].url).toBe(
      "/v1/workspace/runs/run_hook_1/events/stream?token=tkt_hook_run_hook_1_1"
    );
    expect(result.current.isConnected).toBe(false); // connected only after onopen/connected frame
  });

  it("2. Event dispatching: stream events invalidate run/runs plus targeted query families", async () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useRunStream("run_hook_2"), { wrapper: createWrapper(client) });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });
    invalidateSpy.mockClear();

    const es = MockEventSource.instances[0];
    es.emit("run.artifact_created", {
      id: "wev_1",
      run_id: "run_hook_2",
      tenant_id: "tenant_default",
      event_type: "run.artifact_created",
      payload: {},
      ts: 1,
    });
    es.emit("run.approval_decided", {
      id: "wev_2",
      run_id: "run_hook_2",
      tenant_id: "tenant_default",
      event_type: "run.approval_decided",
      payload: {},
      ts: 2,
    });

    const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(["workspace", "run", "run_hook_2"]));
    expect(invalidated).toContain(JSON.stringify(["workspace", "runs"]));
    expect(invalidated).toContain(JSON.stringify(["workspace", "artifacts", "run_hook_2"]));
    expect(invalidated).toContain(JSON.stringify(["workspace", "approvals"]));
  });

  it("3. F6 Reconnection contract: on error, immediately closes dead ES and mints a NEW ticket for reconnect", async () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(
      () => useRunStream("run_hook_3", { maxBackoffMs: 50 }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });

    const firstEs = MockEventSource.instances[0];
    expect(firstEs.url).toContain("tkt_hook_run_hook_3_1");

    // First connection succeeds
    firstEs.onopen?.();
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
    invalidateSpy.mockClear();

    // Trigger error (e.g. network blip or isolate migration)
    firstEs.onerror?.();

    // 1. Dead EventSource was immediately closed
    expect(firstEs.closed).toBe(true);
    await waitFor(() => {
      expect(result.current.status).toBe("reconnecting");
    });

    // 2. Fresh ticket was requested and a new EventSource was created with the new ticket
    await waitFor(
      () => {
        expect(MockEventSource.instances.length).toBe(2);
      },
      { timeout: 1000 },
    );

    const secondEs = MockEventSource.instances[1];
    expect(secondEs.url).toContain("tkt_hook_run_hook_3_2");

    // 3. On reconnect, invalidate queries to synchronize latest state from REST SoT
    secondEs.onopen?.();
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });

    const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(["workspace", "run", "run_hook_3"]));
    expect(invalidated).toContain(JSON.stringify(["workspace", "runs"]));
  });

  it("4. autoReconnect=false: closes the EventSource and transitions to disconnected without reconnect", async () => {
    const client = new QueryClient();
    const { result } = renderHook(
      () => useRunStream("run_hook_4", { autoReconnect: false }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });

    MockEventSource.instances[0].onerror?.();

    expect(MockEventSource.instances[0].closed).toBe(true);
    await waitFor(() => {
      expect(result.current.status).toBe("disconnected");
    });
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("5. Unmount: closes the EventSource and cancels any pending reconnect timer", async () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useRunStream("run_hook_5"), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });

    unmount();

    expect(MockEventSource.instances[0].closed).toBe(true);
  });
});
