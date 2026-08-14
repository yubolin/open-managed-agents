// Stable alert fingerprinting.
//
// A fingerprint identifies one firing condition so repeat occurrences can be
// folded into a single open alert (and a single triage session). Sources that
// provide their own identity (Alertmanager `fingerprint`/`groupKey`) use it
// verbatim; everything else falls back to sha256 over the alert name plus a
// stable subset of labels.
//
// Label subset rule: only labels listed in FINGERPRINT_LABELS participate, so
// volatile labels (instance timestamps, trigger timestamps, attempt counters)
// don't split one logical condition into many fingerprints. The subset is
// sorted by key before hashing.

import { createHash } from "node:crypto";

/** Labels that participate in the fallback fingerprint. Extend deliberately —
 *  every addition changes existing fingerprints and would orphan open alerts. */
export const FINGERPRINT_LABELS: readonly string[] = [
  "alertname",
  "host",
  "instance",
  "job",
  "service",
  "device",
  "severity_source",
];

/** Stable hash over name + sorted stable-label pairs. */
export function computeFingerprint(
  name: string,
  labels: Record<string, string>,
): string {
  const parts = [name];
  for (const key of [...FINGERPRINT_LABELS].sort()) {
    const v = labels[key];
    if (v !== undefined) parts.push(`${key}=${v}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** True when `lastSeenAt` is inside the dedup window relative to `nowMs`. */
export function withinDedupWindow(
  lastSeenAt: number,
  nowMs: number,
  windowMs: number,
): boolean {
  return nowMs - lastSeenAt <= windowMs;
}
