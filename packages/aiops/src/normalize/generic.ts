// Generic alert payload → NormalizedAlertInput.
//
// For sources without a dedicated normalizer (cloud monitors, homegrown
// gates). Contract — POST a single JSON object:
//   { name: string, severity?: "critical"|"warning"|"info",
//     labels?: Record<string,string>, annotations?: Record<string,string>,
//     fingerprint?: string, startsAt?: number|ISOString,
//     endsAt?: number|ISOString|null, resolved?: boolean }
//
// Validation is zod at this boundary (system input); malformed payloads throw
// ZodError so the webhook route can 400 with the issues instead of storing
// garbage.

import { z } from "zod";
import type { NormalizedAlertInput } from "../domain.js";
import { computeFingerprint } from "../fingerprint.js";

const genericAlertSchema = z.object({
  name: z.string().min(1),
  severity: z.enum(["critical", "warning", "info"]).optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  fingerprint: z.string().min(1).optional(),
  startsAt: z.union([z.number(), z.string()]).optional(),
  endsAt: z.union([z.number(), z.string(), z.null()]).optional(),
  resolved: z.boolean().optional(),
});

export type GenericAlertInput = z.infer<typeof genericAlertSchema>;

function toEpochMs(v: number | string | null | undefined, fallback: number): number | null {
  if (v === undefined) return fallback;
  if (v === null) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : t;
}

export function normalizeGeneric(
  body: unknown,
  nowMs: number,
): NormalizedAlertInput[] {
  const parsed = genericAlertSchema.parse(body);
  const labels = parsed.labels ?? {};
  return [
    {
      source: "generic",
      fingerprint: parsed.fingerprint ?? computeFingerprint(parsed.name, labels),
      severity: parsed.severity ?? "warning",
      name: parsed.name,
      labels,
      annotations: parsed.annotations ?? {},
      startsAt: toEpochMs(parsed.startsAt, nowMs) ?? nowMs,
      endsAt: toEpochMs(parsed.endsAt, nowMs ?? nowMs),
      resolved: parsed.resolved ?? false,
    },
  ];
}
