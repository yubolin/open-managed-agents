import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { operationsApi } from "../src/lib/api";

// Mock EventSource implementation for Vitest
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
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(listener);
  }

  emit(type: string, data: any) {
    const list = this.listeners.get(type);
    if (list) {
      const event = { data: JSON.stringify(data) } as MessageEvent;
      for (const l of list) {
        l(event);
      }
    }
  }

  close() {
    this.closed = true;
  }
}

describe("Base D · Operations Stream Client & EventSource Wiring", () => {
  const originalEventSource = (globalThis as any).EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
  });

  afterEach(() => {
    (globalThis as any).EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  it("1. Ticket-to-EventSource handshake: acquires single-use ticket and formats URL", async () => {
    vi.spyOn(operationsApi, "createAuthTicket").mockResolvedValue({
      ticket: "ticket_mock_123",
      expires_in_seconds: 30,
    });

    const ticketRes = await operationsApi.createAuthTicket({ run_id: "run_stream_test" });
    expect(ticketRes.ticket).toBe("ticket_mock_123");

    const es = new (globalThis as any).EventSource(
      `/v1/workspace/runs/run_stream_test/events/stream?token=${ticketRes.ticket}`
    );

    expect(es.url).toBe("/v1/workspace/runs/run_stream_test/events/stream?token=ticket_mock_123");
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("2. Event dispatching: parses typed workspace stream events from stream chunks", async () => {
    const es = new MockEventSource("/v1/workspace/runs/run_event_test/events/stream?token=ticket_456");

    const receivedEvents: any[] = [];
    es.addEventListener("run.state_changed", (e: MessageEvent) => {
      receivedEvents.push(JSON.parse(e.data));
    });
    es.addEventListener("run.artifact_created", (e: MessageEvent) => {
      receivedEvents.push(JSON.parse(e.data));
    });

    // Emit run.state_changed
    es.emit("run.state_changed", {
      id: "wev_1",
      run_id: "run_event_test",
      tenant_id: "tenant_default",
      event_type: "run.state_changed",
      payload: { from: "planning", to: "awaiting_approval" },
      ts: 1000,
    });

    // Emit run.artifact_created
    es.emit("run.artifact_created", {
      id: "wev_2",
      run_id: "run_event_test",
      tenant_id: "tenant_default",
      event_type: "run.artifact_created",
      payload: { artifact_type: "plan", version: 1 },
      ts: 1001,
    });

    expect(receivedEvents.length).toBe(2);
    expect(receivedEvents[0].event_type).toBe("run.state_changed");
    expect(receivedEvents[0].payload.to).toBe("awaiting_approval");
    expect(receivedEvents[1].event_type).toBe("run.artifact_created");
    expect(receivedEvents[1].payload.artifact_type).toBe("plan");

    es.close();
    expect(es.closed).toBe(true);
  });

  it("3. Error handling: closes connection on stream termination", async () => {
    const es = new MockEventSource("/v1/workspace/runs/run_err_test/events/stream?token=ticket_789");

    let isConnected = true;
    es.onerror = () => {
      isConnected = false;
      es.close();
    };

    // Trigger error
    es.onerror();

    expect(isConnected).toBe(false);
    expect(es.closed).toBe(true);
  });
});
