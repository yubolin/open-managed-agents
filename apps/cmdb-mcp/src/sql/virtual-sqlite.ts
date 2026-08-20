import { createRequire } from "node:module";
import { Logger, defaultLogger } from "../logger.js";
import { validateReadOnlySql } from "./safety.js";
import type { SqlQueryResult } from "./db.js";

const req = createRequire(import.meta.url);
let DatabaseSyncClass: any;
try {
  DatabaseSyncClass = req("node:sqlite").DatabaseSync;
} catch {
  // fallback if not available
}

export interface SyncProvider {
  request<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T>;
}

export class VirtualSqliteDb {
  private db?: any;
  private logger: Logger;
  private lastSyncedAt: number = 0;
  private syncTtlMs: number;
  private syncingPromise?: Promise<void>;

  constructor(logger: Logger = defaultLogger, syncTtlMs: number = 60_000) {
    this.logger = logger;
    this.syncTtlMs = syncTtlMs;
    if (DatabaseSyncClass) {
      this.db = new DatabaseSyncClass(":memory:");
      this.initSchema();
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        tenant_name TEXT,
        role TEXT
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        instance_name TEXT,
        hostname TEXT,
        asset_type TEXT,
        entity_class TEXT,
        asset_class TEXT,
        vendor TEXT,
        status TEXT,
        region TEXT,
        cloud_account TEXT,
        project_code TEXT,
        cost_allocation_name TEXT,
        cpu_cores INTEGER DEFAULT 0,
        memory_mb INTEGER DEFAULT 0,
        ip TEXT,
        attributes TEXT,
        tags TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        target_id TEXT,
        relation_type TEXT,
        created_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_assets_tenant ON assets(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
      CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
      CREATE INDEX IF NOT EXISTS idx_assets_vendor ON assets(vendor);
    `);
  }

  async ensureSynced(provider: SyncProvider): Promise<void> {
    if (!this.db) return;
    const now = Date.now();
    if (this.lastSyncedAt > 0 && now - this.lastSyncedAt < this.syncTtlMs) {
      return;
    }

    if (this.syncingPromise) {
      return this.syncingPromise;
    }

    this.syncingPromise = (async () => {
      const start = Date.now();
      try {
        // 1. Fetch Tenants
        let tenants: Array<{ tenant_id: string; tenant_name: string; role?: string }> = [];
        let tenantsFetched = false;
        try {
          const res = await provider.request<
            Array<{ tenant_id: string; tenant_name: string; role?: string }>
          >("/api/v1/auth/tenants");
          if (Array.isArray(res)) {
            tenants = res;
            tenantsFetched = true;
          }
        } catch (err) {
          this.logger.warn(
            { err: String(err) },
            "VirtualSqlite: failed to fetch tenants, preserving cached table",
          );
        }

        // 2. Fetch Assets (with full pagination loop) - Required
        const allAssets: Array<Record<string, unknown>> = [];
        let page = 1;
        const pageSize = 500;
        while (true) {
          const assetsRes = await provider.request<{
            items?: Array<Record<string, unknown>>;
            total?: number;
          }>("/api/v1/assets/", { page, page_size: pageSize });

          const items = assetsRes.items || [];
          allAssets.push(...items);

          if (
            items.length < pageSize ||
            (assetsRes.total !== undefined && allAssets.length >= assetsRes.total)
          ) {
            break;
          }
          page++;
        }

        // 3. Fetch Relations (with pagination)
        const allRelations: Array<Record<string, unknown>> = [];
        let relationsFetched = false;
        try {
          let relPage = 1;
          while (true) {
            const relsRes = await provider.request<{
              items?: Array<Record<string, unknown>>;
              total?: number;
            }>("/api/v1/relations/", { page: relPage, page_size: pageSize });

            const rels = relsRes.items || [];
            allRelations.push(...rels);

            if (
              rels.length < pageSize ||
              (relsRes.total !== undefined && allRelations.length >= relsRes.total)
            ) {
              break;
            }
            relPage++;
          }
          relationsFetched = true;
        } catch (err) {
          this.logger.warn(
            { err: String(err) },
            "VirtualSqlite: failed to fetch relations, preserving cached table",
          );
        }

        // 4. Atomic transaction replace in SQLite (only replaces successfully fetched tables)
        this.db.exec("BEGIN TRANSACTION;");
        try {
          // Replace tenants ONLY if successfully fetched
          if (tenantsFetched) {
            this.db.exec("DELETE FROM tenants;");
            if (tenants.length > 0) {
              const insertTenant = this.db.prepare(
                "INSERT INTO tenants (tenant_id, tenant_name, role) VALUES (?, ?, ?)",
              );
              for (const t of tenants) {
                insertTenant.run(t.tenant_id, t.tenant_name || t.tenant_id, t.role || "user");
              }
            }
          }

          // Replace assets
          this.db.exec("DELETE FROM assets;");
          const insertAsset = this.db.prepare(`
            INSERT INTO assets (
              id, tenant_id, instance_name, hostname, asset_type, entity_class,
              asset_class, vendor, status, region, cloud_account, project_code,
              cost_allocation_name, cpu_cores, memory_mb, ip, attributes, tags,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const item of allAssets) {
            const id = String(item.id || item.instance_id || "");
            const tenantId = String(item.tenant_id || "");
            const instanceName = item.instance_name ? String(item.instance_name) : undefined;
            const rawAttrs = (item.attributes || {}) as Record<string, unknown>;
            const rawTags = (item.tags || {}) as Record<string, unknown>;

            const hostname =
              instanceName || (rawAttrs.hostname ? String(rawAttrs.hostname) : undefined);
            const assetType = String(item.asset_type || "unknown");
            const entityClass =
              assetType === "ecs" || assetType === "vm"
                ? "vm"
                : assetType === "rds" || assetType === "database"
                  ? "database"
                  : assetType;

            const cpuCores = typeof rawAttrs.cpu_cores === "number" ? rawAttrs.cpu_cores : 0;
            const memoryMb = typeof rawAttrs.memory_mb === "number" ? rawAttrs.memory_mb : 0;
            const ip = rawAttrs.ip
              ? String(rawAttrs.ip)
              : rawAttrs.private_ip
                ? String(rawAttrs.private_ip)
                : rawAttrs.public_ip
                  ? String(rawAttrs.public_ip)
                  : undefined;

            insertAsset.run(
              id,
              tenantId,
              instanceName || null,
              hostname || null,
              assetType,
              entityClass,
              item.asset_class ? String(item.asset_class) : "core",
              item.vendor ? String(item.vendor) : "unknown",
              item.status ? String(item.status) : "unknown",
              item.region ? String(item.region) : null,
              item.cloud_account ? String(item.cloud_account) : null,
              item.project_code ? String(item.project_code) : null,
              item.cost_allocation_name ? String(item.cost_allocation_name) : null,
              cpuCores,
              memoryMb,
              ip || null,
              JSON.stringify(rawAttrs),
              JSON.stringify(rawTags),
              item.created_at ? String(item.created_at) : null,
              item.updated_at ? String(item.updated_at) : null,
            );
          }

          // Replace relations ONLY if successfully fetched
          if (relationsFetched) {
            this.db.exec("DELETE FROM relations;");
            if (allRelations.length > 0) {
              const insertRel = this.db.prepare(
                "INSERT INTO relations (id, source_id, target_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
              );
              for (const r of allRelations) {
                insertRel.run(
                  String(r.id || `${r.source_id}->${r.target_id}`),
                  String(r.source_id || ""),
                  String(r.target_id || ""),
                  String(r.relation_type || "depends_on"),
                  r.created_at ? String(r.created_at) : null,
                );
              }
            }
          }

          this.db.exec("COMMIT;");
        } catch (dbErr) {
          this.db.exec("ROLLBACK;");
          throw dbErr;
        }

        this.lastSyncedAt = Date.now();
        this.logger.info(
          {
            op: "virtual_sqlite.synced",
            assets_count: allAssets.length,
            relations_count: allRelations.length,
            duration_ms: Date.now() - start,
          },
          "Virtual in-memory SQLite synchronized from CMDB API",
        );
      } catch (err) {
        this.logger.error({ err: String(err) }, "VirtualSqlite: synchronization failed");
        throw err;
      } finally {
        this.syncingPromise = undefined;
      }
    })();

    return this.syncingPromise;
  }

  executeQuery(rawSql: string, customLimit?: number): SqlQueryResult {
    const limit = Math.min(Math.max(customLimit || 200, 1), 1000);
    const { safeSql } = validateReadOnlySql(rawSql, limit);

    // Normalize MySQL/Postgres json operators for SQLite compatibility:
    // e.g. `attributes->>'$.memory_mb'` -> `json_extract(attributes, '$.memory_mb')`
    // e.g. `attributes->>'memory_mb'` -> `json_extract(attributes, '$.memory_mb')`
    let sqliteSql = safeSql
      .replace(
        /(\w+)->>'?\$?\.?([a-zA-Z0-9_]+)'?/g,
        "json_extract($1, '$.$2')",
      )
      .replace(
        /(\w+)->'\$?\.?([a-zA-Z0-9_]+)'/g,
        "json_extract($1, '$.$2')",
      );

    if (!this.db) {
      throw new Error("Virtual SQLite database is not available");
    }

    const start = Date.now();
    const stmt = this.db.prepare(sqliteSql);
    const rows = stmt.all() as Record<string, unknown>[];
    const durationMs = Date.now() - start;

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    this.logger.info(
      { op: "virtual_sqlite.query_ok", row_count: rows.length, duration_ms: durationMs },
      "Executed read-only virtual SQLite query",
    );

    return {
      columns,
      rows,
      row_count: rows.length,
      duration_ms: durationMs,
      sql_executed: sqliteSql,
    };
  }
}
