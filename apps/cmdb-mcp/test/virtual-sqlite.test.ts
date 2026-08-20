import { describe, it, expect, vi } from "vitest";
import { VirtualSqliteDb, type SyncProvider } from "../src/sql/virtual-sqlite.js";

describe("VirtualSqliteDb", () => {
  it("paginates assets and executes queries", async () => {
    const db = new VirtualSqliteDb();

    // Mock provider with 2 pages of assets
    const mockProvider: SyncProvider = {
      request: vi.fn().mockImplementation(async (path: string, query?: Record<string, unknown>) => {
        if (path === "/api/v1/auth/tenants") {
          return [{ tenant_id: "tn-1", tenant_name: "Tenant 1" }];
        }
        if (path === "/api/v1/assets/") {
          const page = Number(query?.page || 1);
          if (page === 1) {
            const items = Array.from({ length: 500 }, (_, i) => ({
              id: `ast-${i + 1}`,
              tenant_id: "tn-1",
              instance_name: `web-${i + 1}`,
              asset_type: "ecs",
              attributes: { cpu_cores: 4, memory_mb: 8192 },
            }));
            return { total: 501, items };
          } else {
            return {
              total: 501,
              items: [
                { id: "ast-501", tenant_id: "tn-1", instance_name: "db-01", asset_type: "rds", attributes: { cpu_cores: 16, memory_mb: 65536 } },
              ],
            };
          }
        }
        if (path === "/api/v1/relations/") {
          return { items: [{ id: "rel-1", source_id: "ast-1", target_id: "ast-3", relation_type: "depends_on" }] };
        }
        return {};
      }),
    };

    await db.ensureSynced(mockProvider);

    // Verify pagination called page 1 and page 2
    expect(mockProvider.request).toHaveBeenCalledWith("/api/v1/assets/", { page: 1, page_size: 500 });
    expect(mockProvider.request).toHaveBeenCalledWith("/api/v1/assets/", { page: 2, page_size: 500 });

    // Query assets
    const res = db.executeQuery("SELECT id, instance_name, asset_type, cpu_cores, memory_mb FROM assets", 1000);
    expect(res.row_count).toBe(501);

    const ast1 = db.executeQuery("SELECT id, instance_name, cpu_cores, memory_mb FROM assets WHERE id = 'ast-1'");
    expect(ast1.rows[0]).toMatchObject({ id: "ast-1", instance_name: "web-1", cpu_cores: 4, memory_mb: 8192 });

    const ast501 = db.executeQuery("SELECT id, instance_name, cpu_cores, memory_mb FROM assets WHERE id = 'ast-501'");
    expect(ast501.rows[0]).toMatchObject({ id: "ast-501", instance_name: "db-01", cpu_cores: 16, memory_mb: 65536 });

    // Query JSON operator compatibility
    const jsonRes = db.executeQuery("SELECT id, attributes->>'$.cpu_cores' as cpu FROM assets WHERE id = 'ast-1'");
    expect(jsonRes.rows[0]).toMatchObject({ id: "ast-1", cpu: 4 });
  });

  it("atomically purges deleted upstream assets on refresh", async () => {
    const db = new VirtualSqliteDb(undefined, 0); // ttl = 0 for immediate refresh

    let currentAssets = [
      { id: "ast-1", instance_name: "web-01", asset_type: "ecs" },
      { id: "ast-2", instance_name: "web-02", asset_type: "ecs" },
    ];

    const provider: SyncProvider = {
      request: vi.fn().mockImplementation(async (path: string) => {
        if (path === "/api/v1/assets/") {
          return { items: currentAssets, total: currentAssets.length };
        }
        return { items: [] };
      }),
    };

    await db.ensureSynced(provider);
    expect(db.executeQuery("SELECT count(*) as cnt FROM assets").rows[0]).toMatchObject({ cnt: 2 });

    // Upstream deleted ast-1
    currentAssets = [{ id: "ast-2", instance_name: "web-02", asset_type: "ecs" }];

    await db.ensureSynced(provider);
    const refreshed = db.executeQuery("SELECT id FROM assets");
    expect(refreshed.row_count).toBe(1);
    expect(refreshed.rows[0]).toMatchObject({ id: "ast-2" });
  });

  it("throws and does not cache when asset synchronization fails", async () => {
    const db = new VirtualSqliteDb();

    const failingProvider: SyncProvider = {
      request: vi.fn().mockImplementation(async (path: string) => {
        if (path === "/api/v1/assets/") {
          throw new Error("Network timeout to CMDB");
        }
        return [];
      }),
    };

    await expect(db.ensureSynced(failingProvider)).rejects.toThrow("Network timeout to CMDB");

    // Second call should still try to sync and not skip via false lastSyncedAt
    await expect(db.ensureSynced(failingProvider)).rejects.toThrow("Network timeout to CMDB");
    expect(failingProvider.request).toHaveBeenCalledTimes(4); // 2 auth + 2 assets
  });
});
