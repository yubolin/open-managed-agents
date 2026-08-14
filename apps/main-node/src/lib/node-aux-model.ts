// Node aux_model resolution — mirror of CF session-do.ts resolveAuxModel.
//
// Task 2 (§3.8): agent.aux_model feeds buildTools' { auxModel,
// auxModelInfo } env so web_fetch can summarize large pages and offload
// the raw markdown to /workspace/.web/.
//
// Failure semantics deliberately differ from the primary model: a failed
// aux resolution degrades to null + warn (web_fetch returns raw markdown)
// instead of failing the whole turn.
//
// DI-based (no index.ts imports) so it stays unit-testable: the caller
// injects the same resolveNodeModelCreds closure used for the primary
// model plus a buildModel wrapper around resolveModel.

import type { LanguageModel } from "ai";

/** Credential shape produced by main-node's resolveNodeModelCreds. */
export interface NodeModelCreds {
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  apiCompat?: "ant" | "ant-compatible" | "oai" | "oai-compatible";
  customHeaders?: Record<string, string>;
}

export interface AuxModelResult {
  model: LanguageModel;
  modelInfo: { model_id: string };
}

export async function resolveNodeAuxModel(opts: {
  tenantId: string;
  /** agent.aux_model — string handle or { id, speed } object. */
  auxModel: string | { id: string; speed?: string } | undefined;
  /** Same resolver used for the primary model (model card → env fallback). */
  resolveCredentials: (
    tenantId: string,
    model: string | { id: string; speed?: string },
  ) => Promise<NodeModelCreds>;
  /** Turn resolved creds into a LanguageModel (wraps resolveModel). */
  buildModel: (creds: NodeModelCreds) => LanguageModel;
  warn?: (msg: string) => void;
}): Promise<AuxModelResult | null> {
  const { tenantId, auxModel, resolveCredentials, buildModel } = opts;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  if (!auxModel) return null;
  const handle = typeof auxModel === "string" ? auxModel : auxModel.id;
  try {
    const creds = await resolveCredentials(tenantId, auxModel);
    return { model: buildModel(creds), modelInfo: { model_id: handle } };
  } catch (err) {
    warn(
      `[aux-model] resolution failed for ${handle}, disabling aux features: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
