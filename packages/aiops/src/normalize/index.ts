// Format sniffing + fan-out for the webhook route: pick the normalizer by
// payload shape, never by caller declaration.

import type { NormalizedAlertInput } from "../domain.js";
import { normalizeAlertmanager } from "./alertmanager.js";
import { normalizeGeneric } from "./generic.js";

export { normalizeAlertmanager, mapAlertmanagerSeverity } from "./alertmanager.js";
export { normalizeGeneric } from "./generic.js";

/**
 * Normalize any accepted webhook body. Sniffs Alertmanager by the presence of
 * an `alerts` array; everything else goes through the zod-validated generic
 * schema (which throws ZodError on malformed input — the route maps that to
 * a 400). Returns one NormalizedAlertInput per alert in the payload.
 */
export function normalizeAlertPayload(
  body: unknown,
  nowMs: number,
): NormalizedAlertInput[] {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).alerts)
  ) {
    return normalizeAlertmanager(body, nowMs);
  }
  return normalizeGeneric(body, nowMs);
}
