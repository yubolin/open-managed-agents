// Tiny .env loader + resolved config. No dotenv dependency: read ./.env next
// to the process cwd if present, parse KEY=VALUE lines, and only fill
// process.env slots that are not already set. Then snapshot the config once.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .env — env vars only
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface Config {
  omaBase: string;
  omaApiKey: string;
  /** Sessions bind this environment (required for cloud agents). */
  omaEnvironmentId: string;
  supervisorName: string;
  expertNames: Record<"sre" | "network" | "db" | "security", string>;
  supervisorMaxTurns: number;
  turnTimeoutMs: number;
  watchPollMs: number;
}

export function loadConfig(): Config {
  return {
    omaBase: (process.env.OMA_BASE ?? "http://localhost:8787").replace(/\/+$/, ""),
    omaApiKey: process.env.OMA_API_KEY ?? "test-key",
    omaEnvironmentId: process.env.OMA_ENVIRONMENT_ID ?? "",
    supervisorName: process.env.SUPERVISOR_NAME ?? "aiops-duty-supervisor",
    expertNames: {
      sre: process.env.EXPERT_SRE_NAME ?? "aiops-expert-sre",
      network: process.env.EXPERT_NETWORK_NAME ?? "aiops-expert-network",
      db: process.env.EXPERT_DB_NAME ?? "aiops-expert-db",
      security: process.env.EXPERT_SECURITY_NAME ?? "aiops-expert-security",
    },
    supervisorMaxTurns: num("SUPERVISOR_MAX_TURNS", 3),
    turnTimeoutMs: num("TURN_TIMEOUT_MS", 180_000),
    watchPollMs: num("WATCH_POLL_MS", 5_000),
  };
}
