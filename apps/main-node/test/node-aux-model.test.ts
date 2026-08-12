// Node aux_model resolution — mirror of CF session-do.ts resolveAuxModel.
//
// Task 2 (§3.8): agent.aux_model must resolve into buildTools'
// { auxModel, auxModelInfo } env so web_fetch can summarize large pages.
// Failure semantics: resolution errors degrade to null + warn (web_fetch
// falls back to raw markdown) instead of failing the whole turn —
// unlike the primary model, which throws.

import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import {
  resolveNodeAuxModel,
  type NodeModelCreds,
} from "../src/lib/node-aux-model.js";

const TENANT = "tenant-aux";

function fakeCreds(handle: string): NodeModelCreds {
  return { wireModel: `wire-${handle}`, apiKey: "sk-aux" };
}

const fakeModel = { provider: "fake", modelId: "aux-model" } as unknown as LanguageModel;

describe("resolveNodeAuxModel", () => {
  it("no aux_model configured → null (creds resolver never called)", async () => {
    let called = false;
    const aux = await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: undefined,
      resolveCredentials: async () => {
        called = true;
        return fakeCreds("x");
      },
      buildModel: () => fakeModel,
    });
    expect(aux).toBeNull();
    expect(called).toBe(false);
  });

  it("string form resolves and reports model_id = handle", async () => {
    const seen: Array<[string, string | { id: string }]> = [];
    const aux = await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: "claude-haiku-4-5",
      resolveCredentials: async (tenantId, model) => {
        seen.push([tenantId, model]);
        return fakeCreds("claude-haiku-4-5");
      },
      buildModel: () => fakeModel,
    });
    expect(aux).not.toBeNull();
    expect(aux!.model).toBe(fakeModel);
    expect(aux!.modelInfo).toEqual({ model_id: "claude-haiku-4-5" });
    expect(seen).toEqual([[TENANT, "claude-haiku-4-5"]]);
  });

  it("object { id } form resolves and reports model_id = id", async () => {
    const aux = await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: { id: "fast-model", speed: "fast" },
      resolveCredentials: async () => fakeCreds("fast-model"),
      buildModel: () => fakeModel,
    });
    expect(aux!.modelInfo).toEqual({ model_id: "fast-model" });
  });

  it("buildModel receives the creds returned by the resolver", async () => {
    let got: NodeModelCreds | undefined;
    await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: "aux-x",
      resolveCredentials: async () => ({
        wireModel: "wire-aux-x",
        apiKey: "sk-1",
        baseURL: "https://aux.example",
        apiCompat: "ant",
      }),
      buildModel: (creds) => {
        got = creds;
        return fakeModel;
      },
    });
    expect(got).toEqual({
      wireModel: "wire-aux-x",
      apiKey: "sk-1",
      baseURL: "https://aux.example",
      apiCompat: "ant",
    });
  });

  it("credential resolution failure → null + warn (turn must not fail)", async () => {
    const warnings: string[] = [];
    const aux = await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: "missing-card",
      resolveCredentials: async () => {
        throw new Error("No model card matched and ANTHROPIC_API_KEY is unset");
      },
      buildModel: () => fakeModel,
      warn: (msg) => warnings.push(msg),
    });
    expect(aux).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toContain("missing-card");
  });

  it("buildModel failure → null + warn (turn must not fail)", async () => {
    const warnings: string[] = [];
    const aux = await resolveNodeAuxModel({
      tenantId: TENANT,
      auxModel: "bad-provider",
      resolveCredentials: async () => fakeCreds("bad-provider"),
      buildModel: () => {
        throw new Error("unsupported provider");
      },
      warn: (msg) => warnings.push(msg),
    });
    expect(aux).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
