// Shared DB bootstrap for the Base E pilot scripts (seed + drill).
// Mirrors the main-node boot branches exactly (src/index.ts): DATABASE_URL
// with a postgres scheme → postgres-js; otherwise sqlite at DATABASE_PATH
// (default ./data/oma.db) with FK enforcement OFF to match D1's runtime.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OmaDb } from "@open-managed-agents/db-schema";

export const PILOT_TENANT_DEFAULT = "tenant_default";
export const PILOT_TEMPLATE_ID = "stpl_pilot_timeout";

export function resolvePilotTenant(): string {
  return process.env.OPERATIONS_PILOT_TENANT ?? PILOT_TENANT_DEFAULT;
}

export async function openPilotDb(): Promise<OmaDb<Record<string, unknown>>> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const usePostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
  if (usePostgres) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgresMod = (await import("postgres" as string)) as {
      default: (dsn: string) => unknown;
    };
    return drizzle(postgresMod.default(dbUrl) as never) as unknown as OmaDb<
      Record<string, unknown>
    >;
  }
  const defaultSqlitePath = resolve(import.meta.dirname, "../../data/oma.db");
  const dbPath = process.env.DATABASE_PATH ?? defaultSqlitePath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const sqliteRaw = new BetterSqlite3(dbPath);
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  return drizzle(sqliteRaw) as unknown as OmaDb<Record<string, unknown>>;
}
