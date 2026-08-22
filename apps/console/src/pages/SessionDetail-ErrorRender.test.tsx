import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EventRender } from "./SessionDetail";
import type { SessionErrorEvent } from "@open-managed-agents/api-types";

describe("SessionDetail session.error rendering", () => {
  it("renders session.error with string error, message, and structured details", () => {
    const errorEvent: SessionErrorEvent = {
      type: "session.error",
      error: "Context window exceeded",
      message: "Model input budget overflow: estimated 210,000 tokens > 200,000 budget.",
      details: {
        provider: "minimax-m2.7",
        estimated_input_tokens: 210000,
        context_window_tokens: 204800,
      },
    };

    const html = renderToStaticMarkup(<EventRender event={errorEvent as any} />);

    expect(html).toContain("Error: Context window exceeded");
    expect(html).toContain("Model input budget overflow: estimated 210,000 tokens &gt; 200,000 budget.");
    expect(html).toContain("minimax-m2.7");
    expect(html).toContain("210000");
    expect(html).toContain("204800");
  });

  it("renders session.error with structured error object", () => {
    const errorEvent: SessionErrorEvent = {
      type: "session.error",
      error: {
        type: "provider_error",
        message: "Anthropic credit limit reached",
        retry_status: "non_retryable",
      },
      message: "Please top up your API key.",
    };

    const html = renderToStaticMarkup(<EventRender event={errorEvent as any} />);

    expect(html).toContain("Error: Anthropic credit limit reached");
    expect(html).toContain("Please top up your API key.");
  });

  it("renders session.error with missing error gracefully", () => {
    const errorEvent: Partial<SessionErrorEvent> = {
      type: "session.error",
      message: "Something went wrong without error details.",
    };

    const html = renderToStaticMarkup(<EventRender event={errorEvent as any} />);

    expect(html).toContain("Error: Unknown error");
    expect(html).toContain("Something went wrong without error details.");
  });
});
