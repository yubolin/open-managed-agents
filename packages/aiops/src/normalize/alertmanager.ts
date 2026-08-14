// Alertmanager webhook payload → NormalizedAlertInput[].
//
// Accepts the standard Alertmanager (Prometheus) webhook POST body
// (https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).
// One input per entry in `alerts`; the batch fields (commonLabels etc.) are
// only fallbacks — per-alert labels win.

import type { NormalizedAlertInput } from "../domain.js";
import type { AiopsSeverity } from "../domain.js";
import { computeFingerprint } from "../fingerprint.js";

/** Alertmanager severity label → AiopsSeverity. Unknown values degrade to
 *  info rather than erroring — an unmapped severity should not drop an alert. */
export function mapAlertmanagerSeverity(raw: string | undefined): AiopsSeverity {
  switch ((raw ?? "").toLowerCase()) {
    case "critical":
    case "page":
    case "severe":
      return "critical";
    case "warning":
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

/** Alertmanager uses the zero timestamp for "not ended"; normalize to null. */
function parseEndsAt(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  if (t <= Date.parse("0001-01-01T00:00:00Z") + 1000) return null;
  return t;
}

/** Parse an Alertmanager webhook body. Returns [] for payloads with no
 *  `alerts` array (callers sniff the format before calling — see
 *  normalize/index.ts). Throws never: malformed entries degrade to
 *  info-severity alerts with best-effort fields. */
export function normalizeAlertmanager(
  body: unknown,
  nowMs: number,
): NormalizedAlertInput[] {
  if (typeof body !== "object" || body === null) return [];
  const root = body as Record<string, unknown>;
  if (!Array.isArray(root.alerts)) return [];
  const commonLabels = toStringMap(root.commonLabels);
  const commonAnnotations = toStringMap(root.commonAnnotations);

  const out: NormalizedAlertInput[] = [];
  for (const rawAlert of root.alerts) {
    if (typeof rawAlert !== "object" || rawAlert === null) continue;
    const alert = rawAlert as Record<string, unknown>;
    const labels = { ...commonLabels, ...toStringMap(alert.labels) };
    const annotations = {
      ...commonAnnotations,
      ...toStringMap(alert.annotations),
    };
    const name = labels.alertname || labels.alert_name || "unnamed_alert";
    const resolved = alert.status === "resolved";
    const startsAtRaw = typeof alert.startsAt === "string" ? alert.startsAt : null;
    const startsAt = startsAtRaw ? Date.parse(startsAtRaw) : NaN;
    out.push({
      source: "alertmanager",
      fingerprint:
        typeof alert.fingerprint === "string" && alert.fingerprint
          ? alert.fingerprint
          : computeFingerprint(name, labels),
      severity: mapAlertmanagerSeverity(labels.severity),
      name,
      labels,
      annotations,
      startsAt: Number.isNaN(startsAt) ? nowMs : startsAt,
      endsAt: parseEndsAt(typeof alert.endsAt === "string" ? alert.endsAt : undefined),
      resolved,
    });
  }
  return out;
}

function toStringMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
    else if (val !== null && val !== undefined) out[k] = String(val);
  }
  return out;
}
