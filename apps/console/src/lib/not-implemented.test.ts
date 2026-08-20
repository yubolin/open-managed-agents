// F8 (SDS agent-self-install §2.7 / runtime-capabilities §4): a Node
// runtime answers the 5 stub APIs with 501 {error, runtime:"node"}.
// Clients must render "not implemented" — never a silent empty list.
// These tests pin the discriminator the pages branch on.

import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { isNotImplementedError } from "./not-implemented";

describe("isNotImplementedError (501 discriminator)", () => {
  it("ApiError with status 501 → true", () => {
    const err = new ApiError({
      status: 501,
      code: "",
      message: "Not Implemented in this runtime",
    });
    expect(isNotImplementedError(err)).toBe(true);
  });

  it("ApiError with status 404 → false (missing resource is NOT unimplemented)", () => {
    const err = new ApiError({ status: 404, code: "", message: "not found" });
    expect(isNotImplementedError(err)).toBe(false);
  });

  it("ApiError with status 200-family never occurs, but 400 → false", () => {
    const err = new ApiError({ status: 400, code: "", message: "bad request" });
    expect(isNotImplementedError(err)).toBe(false);
  });

  it("plain Error (network/abort) → false", () => {
    expect(isNotImplementedError(new Error("fetch failed"))).toBe(false);
  });

  it("null/undefined (loading or success lanes) → false", () => {
    expect(isNotImplementedError(null)).toBe(false);
    expect(isNotImplementedError(undefined)).toBe(false);
  });
});
