// F3 P3-③ (H-2) — route-level proof that the EventSource stream endpoint is
// reachable WITHOUT upstream credentials, while ticket MINT stays gated.
//
// All 4xx bodies pass through errorEnvelopeMiddleware, which normalizes them
// into the Anthropic envelope {type:"error", error:{type,message}, request_id}
// while MIRRORING the original message. The distinguishing evidence is that
// mirrored message: the route's ticket gate says "Missing SSE auth ticket";
// authMiddleware's fallback says bare "Unauthorized". Seeing the route's
// message on a credential-less GET proves the request reached the route
// (exemption works); seeing the bare fallback on a credential-less POST
// proves mint stays behind full auth.

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

interface Envelope {
  message?: string;
  error?: { type?: string; message?: string };
}

function envelopeMessage(body: Envelope): string {
  return body.message ?? body.error?.message ?? "";
}

describe("Operations SSE stream · authMiddleware exemption (workerd, full app)", () => {
  it("auth-1: credential-less stream GET reaches the route's ticket gate, not upstream 401", async () => {
    const res = await SELF.fetch(
      "https://example.com/v1/workspace/runs/run_probe_1/events/stream",
      { headers: { "user-agent": "EventSource/1.0" } }, // what a browser EventSource sends: no x-api-key, no cookie
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    // The ROUTE answered (ticket gate) — authMiddleware's bare
    // "Unauthorized" must NOT be what we see here.
    expect(envelopeMessage(body)).toBe("Unauthorized: Missing SSE auth ticket");
  });

  it("auth-2: ticket mint stays behind full authMiddleware", async () => {
    const res = await SELF.fetch("https://example.com/v1/workspace/auth/ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run_probe_1" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(envelopeMessage(body)).toBe("Unauthorized"); // authMiddleware's fallback message
  });
});
