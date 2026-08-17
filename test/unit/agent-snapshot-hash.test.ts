import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_HASH_ALGORITHM,
  canonicalizeJson,
  hashJsonSnapshot,
} from "../../packages/shared/src/agent-snapshot-hash";

describe("agent snapshot canonical JSON + hash contract", () => {
  it("matches the RFC 8785 number serialization vector", () => {
    expect(
      canonicalizeJson([
        333333333.33333329,
        1e30,
        4.5,
        2e-3,
        0.000000000000000000000000001,
      ]),
    ).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");
  });

  it("orders object keys canonically while preserving array order", () => {
    expect(canonicalizeJson({ z: [3, 2, 1], a: { y: true, x: false } })).toBe(
      '{"a":{"x":false,"y":true},"z":[3,2,1]}',
    );
  });

  it("drops undefined object members using persisted JSON semantics", async () => {
    const prepared = await hashJsonSnapshot({ z: 1, omitted: undefined, a: "kept" });

    expect(prepared.normalized).toEqual({ z: 1, a: "kept" });
    expect(prepared.canonicalJson).toBe('{"a":"kept","z":1}');
    expect(prepared.hashAlgorithm).toBe("sha256:jcs-rfc8785:v1");
    expect(prepared.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(SNAPSHOT_HASH_ALGORITHM).toBe("sha256:jcs-rfc8785:v1");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["BigInt", 1n],
  ])("rejects non-JSON value %s", async (_label, value) => {
    await expect(hashJsonSnapshot({ value })).rejects.toMatchObject({
      code: "snapshot_not_json",
    });
  });

  it("produces the same hash for semantically identical key orderings", async () => {
    const left = await hashJsonSnapshot({ b: 2, a: 1 });
    const right = await hashJsonSnapshot({ a: 1, b: 2 });

    expect(left.configHash).toBe(right.configHash);
    expect(left.canonicalJson).toBe(right.canonicalJson);
  });
});
