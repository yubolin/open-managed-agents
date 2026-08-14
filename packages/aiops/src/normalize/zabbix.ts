// Zabbix webhook normalizer — Phase 2 stub.
//
// Zabbix media-type webhooks are operator-scripted, so the payload shape is
// per-installation. The Phase 2 plan: an `aiops_alert_sources` row per Zabbix
// install carrying its script's JSON contract, plus severity mapping from
// Zabbix trigger priorities (1 disaster, 2 high, 3 average, 4 warn) —
// mapAlertmanagerSeverity-style degradation.
//
// Until then, callers route Zabbix payloads through the generic normalizer.

export type ZabbixNormalizerStatus = "not_implemented";
