import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env loader so the spike has zero non-SDK runtime deps. Existing
// process.env wins (only fills unset keys).
function loadDotenv(path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), path), "utf8");
  } catch {
    return; // .env is optional; real env vars are fine
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv();

const baseSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  MODE: z.enum(["oma", "echo"]).default("oma"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// OMA_* is only required in "oma" mode. Echo mode exercises the Feishu
// plumbing (WS + dedup + send) without an OMA runtime, so blocking it on
// OMA config is needless friction when testing the channel layer alone.
const omaSchema = z.object({
  OMA_BASE_URL: z.string().url(),
  OMA_API_KEY: z.string().min(1),
  OMA_SESSION_ID: z.string().min(1),
});

export type SpikeEnv = {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  MODE: "oma" | "echo";
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  OMA_BASE_URL: string;
  OMA_API_KEY: string;
  OMA_SESSION_ID: string;
};

function formatError(result: z.ZodError): string {
  return result.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

export function loadEnv(): SpikeEnv {
  const base = baseSchema.safeParse(process.env);
  if (!base.success) {
    throw new Error(`Environment validation failed:\n${formatError(base.error)}`);
  }
  if (base.data.MODE === "oma") {
    const oma = omaSchema.safeParse(process.env);
    if (!oma.success) {
      throw new Error(
        `Environment validation failed (OMA_* required when MODE=oma):\n${formatError(oma.error)}`,
      );
    }
    return { ...base.data, ...oma.data };
  }
  return { ...base.data, OMA_BASE_URL: "", OMA_API_KEY: "", OMA_SESSION_ID: "" };
}
