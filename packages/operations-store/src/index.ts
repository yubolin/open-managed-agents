// @open-managed-agents/operations-store barrel exports.

export * from "./types";
export * from "./errors";
export * from "./ports";
export * from "./service";
export * from "./stream";
export * from "./test-fakes";
export * from "./adapters/drizzle";

import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { DrizzleOperationsStore } from "./adapters/drizzle";
import { OperationsService } from "./service";

export function createOperationsService(db: OmaDb): OperationsService {
  const store = new DrizzleOperationsStore(db);
  return new OperationsService(store);
}

export function createCfOperationsService(deps: { db: D1Database }): OperationsService {
  const drz = drizzle(deps.db) as unknown as OmaDb;
  return createOperationsService(drz);
}

export function createSqliteOperationsService(deps: { db: OmaDb }): OperationsService {
  return createOperationsService(deps.db);
}
