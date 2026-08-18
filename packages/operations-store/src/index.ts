// @open-managed-agents/operations-store barrel exports.

export * from "./types";
export * from "./errors";
export * from "./ports";
export * from "./service";
export * from "./stream";
export * from "./sse-tickets";
export * from "./timeout-policy";
export * from "./test-fakes";
export * from "./adapters/drizzle";
export * from "./adapters/drizzle-sse-tickets";

import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { DrizzleOperationsStore } from "./adapters/drizzle";
import { OperationsService } from "./service";
import type { OperationsStreamHubPort } from "./stream";

export interface CreateOperationsServiceOptions {
  /**
   * Hub the service publishes state frames to. DEFAULT: the in-process
   * globalOperationsStreamHub singleton. CONTRACT (F3/H3): when the BFF
   * mounts operationsRoutes with an injected hub, it MUST be this same
   * instance — a mismatch means SSE subscribers never see frames.
   */
  hub?: OperationsStreamHubPort;
}

export function createOperationsService(
  db: OmaDb,
  opts: CreateOperationsServiceOptions = {},
): OperationsService {
  const store = new DrizzleOperationsStore(db);
  return new OperationsService(store, opts.hub);
}

export function createCfOperationsService(deps: { db: D1Database }): OperationsService {
  const drz = drizzle(deps.db) as unknown as OmaDb;
  return createOperationsService(drz);
}

export function createSqliteOperationsService(deps: { db: OmaDb }): OperationsService {
  return createOperationsService(deps.db);
}
