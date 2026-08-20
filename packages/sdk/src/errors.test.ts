// F8 (SDS agent-self-install §2.7): SDK consumers must be able to
// branch a 501 capability gap off a 404 / 400 / network error without
// poking at error internals.

import { describe, it, expect } from "vitest";
import { OpenMAError, isOpenMANotImplemented } from "./errors.js";

describe("isOpenMANotImplemented", () => {
  it("501 with the node marker body → true", () => {
    const err = new OpenMAError(
      501,
      JSON.stringify({ error: "Not Implemented in this runtime", runtime: "node" }),
      "https://api.test/v1/skills",
    );
    expect(isOpenMANotImplemented(err)).toBe(true);
    // The body survived parsing so callers can read runtime:"node".
    expect((err.body as { runtime: string }).runtime).toBe("node");
  });

  it("404 → false (missing resource is a different state)", () => {
    const err = new OpenMAError(404, JSON.stringify({ error: "not found" }), "u");
    expect(isOpenMANotImplemented(err)).toBe(false);
  });

  it("non-OpenMAError → false", () => {
    expect(isOpenMANotImplemented(new Error("fetch failed"))).toBe(false);
    expect(isOpenMANotImplemented(undefined)).toBe(false);
  });
});
