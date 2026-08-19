import { describe, it, expect, vi, beforeEach } from "vitest";
import { CmdbClient, CmdbClientError } from "../src/cmdb-client.js";
import { Logger } from "../src/logger.js";
import type { CmdbMcpConfig } from "../src/config.js";

describe("CmdbClient", () => {
  const silentLogger = new Logger("error");

  const baseConfig: CmdbMcpConfig = {
    port: 3910,
    cmdbBaseUrl: "https://cmdb.test",
    cmdbApiToken: "secret-token-123",
    cmdbAuthHeader: "Authorization",
    cmdbAuthScheme: "Bearer",
    logLevel: "error",
    requestTimeoutMs: 1000,
  };

  it("builds standard Bearer authorization header", async () => {
    let capturedHeaders: HeadersInit | undefined;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          id: "asset-1",
          instance_name: "web-01",
          asset_type: "ecs",
          asset_class: "vm",
          attributes: { private_ip: "10.0.1.5" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    const res = await client.getEntity({ entity_id: "asset-1" });

    expect(res.source).toBe("cmdb");
    expect(res.entity.entity_id).toBe("asset-1");
    expect(res.entity.entity_class).toBe("vm");
    expect(res.entity.hostname).toBe("web-01");
    expect(res.entity.ips).toEqual(["10.0.1.5"]);
    expect((capturedHeaders as Record<string, string>)?.["Authorization"]).toBe("Bearer secret-token-123");
  });

  it("supports custom header name and raw token scheme", async () => {
    let capturedHeaders: HeadersInit | undefined;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "asset-2",
              instance_name: "db-master",
              asset_type: "rds_mysql",
              attributes: { private_ip: "10.0.2.10" },
              tags: { env: "prod", team: "core" },
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const customConfig: CmdbMcpConfig = {
      ...baseConfig,
      cmdbAuthHeader: "X-API-Key",
      cmdbAuthScheme: "",
    };

    const client = new CmdbClient(customConfig, silentLogger, mockFetch);
    const res = await client.getEntity({ ip: "10.0.2.10" });

    expect((capturedHeaders as Record<string, string>)?.["X-API-Key"]).toBe("secret-token-123");
    expect(res.entity.entity_id).toBe("asset-2");
    expect(res.entity.entity_class).toBe("database");
    expect(res.entity.labels).toEqual({ env: "prod", team: "core" });
  });

  it("normalizes relationship models and queries directions", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("source_id") === "app-node-1") {
        return new Response(
          JSON.stringify({
            items: [
              {
                source_id: "app-node-1",
                target_id: "db-mysql-1",
                relation_type: "depends_on",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.searchParams.get("target_id") === "app-node-1") {
        return new Response(
          JSON.stringify({
            items: [
              {
                source_id: "lb-nginx-1",
                target_id: "app-node-1",
                relation_type: "connects_to",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    const res = await client.getRelationships({ entity_id: "app-node-1", direction: "both" });

    expect(res.relationships).toHaveLength(2);
    expect(res.relationships).toEqual([
      { from_entity_id: "app-node-1", to_entity_id: "db-mysql-1", relation: "depends_on" },
      { from_entity_id: "lb-nginx-1", to_entity_id: "app-node-1", relation: "connects_to" },
    ]);
  });

  it("maps 401/403 to CMDB_AUTH_FAILED (retryable: false)", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response(JSON.stringify({ detail: "Not authenticated" }), { status: 401 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    await expect(client.getEntity({ entity_id: "unknown-1" })).rejects.toThrowError(
      expect.objectContaining({
        code: "CMDB_AUTH_FAILED",
        retryable: false,
      }),
    );
  });

  it("maps 404 to CMDB_NOT_FOUND (retryable: false)", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    await expect(client.getEntity({ hostname: "nonexistent-server" })).rejects.toThrowError(
      expect.objectContaining({
        code: "CMDB_NOT_FOUND",
        retryable: false,
      }),
    );
  });

  it("maps 429 to CMDB_RATE_LIMITED (retryable: true)", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    await expect(client.searchEntities({ query: "test" })).rejects.toThrowError(
      expect.objectContaining({
        code: "CMDB_RATE_LIMITED",
        retryable: true,
      }),
    );
  });

  it("retries 5xx once and throws CMDB_UPSTREAM_UNAVAILABLE (retryable: true)", async () => {
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++;
      return new Response("Internal Server Error", { status: 500 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    await expect(client.searchEntities({ query: "test" })).rejects.toThrowError(
      expect.objectContaining({
        code: "CMDB_UPSTREAM_UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(callCount).toBe(2);
  });

  it("authenticates dynamically via username and password when API token is not provided", async () => {
    let loginCalled = false;
    let authHeaderSeen = "";

    const userPassConfig: CmdbMcpConfig = {
      ...baseConfig,
      cmdbApiToken: undefined,
      cmdbUsername: "admin",
      cmdbPassword: "supersecretpassword",
    };

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        loginCalled = true;
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.username).toBe("admin");
        expect(body.password).toBe("supersecretpassword");
        return new Response(
          JSON.stringify({
            access_token: "dyn-jwt-token-777",
            refresh_token: "dyn-refresh-token-888",
            is_super_admin: true,
            tenant_name: "global",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/api/v1/assets/asset-dyn") {
        authHeaderSeen = (init?.headers as Record<string, string>)?.[
          "Authorization"
        ] || "";
        return new Response(
          JSON.stringify({
            id: "asset-dyn",
            instance_name: "admin-box-1",
            asset_type: "ecs",
            attributes: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new CmdbClient(userPassConfig, silentLogger, mockFetch);
    const res = await client.getEntity({ entity_id: "asset-dyn" });

    expect(loginCalled).toBe(true);
    expect(authHeaderSeen).toBe("Bearer dyn-jwt-token-777");
    expect(res.entity.entity_id).toBe("asset-dyn");
    expect(res.entity.hostname).toBe("admin-box-1");
  });

  it("lists and filters tenants via listTenants", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/tenants") {
        return new Response(
          JSON.stringify([
            { tenant_id: "shiseido", tenant_name: "资生堂" },
            { tenant_id: "szsm", tenant_name: "神州数码" },
            { tenant_id: "hitachi", tenant_name: "日立" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    const all = await client.listTenants();
    expect(all.total).toBe(3);

    const filtered = await client.listTenants({ query: "资生堂" });
    expect(filtered.total).toBe(1);
    expect(filtered.tenants[0].tenant_id).toBe("shiseido");
  });

  it("lists asset types via listAssetTypes", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/assets/types") {
        return new Response(
          JSON.stringify({
            items: ["ecs", "rds", "vpc", "acl"],
            options: [
              { value: "ecs", asset_class: "core" },
              { value: "rds", asset_class: "core" },
              { value: "vpc", asset_class: "core" },
              { value: "acl", asset_class: "platform" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    const all = await client.listAssetTypes();
    expect(all.total).toBe(4);

    const core = await client.listAssetTypes({ asset_class: "core" });
    expect(core.total).toBe(3);
    expect(core.types.map((t) => t.type)).toEqual(["ecs", "rds", "vpc"]);
  });

  it("retrieves dashboard stats via getAssetStats", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/dashboard/stats") {
        return new Response(
          JSON.stringify({
            total_assets: 400,
            by_type: { ecs: 28, rds: 1 },
            by_vendor: { azure: 281, aws: 92, aliyun: 27 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const client = new CmdbClient(baseConfig, silentLogger, mockFetch);
    const stats = (await client.getAssetStats()) as {
      total_assets: number;
      by_type: Record<string, number>;
    };
    expect(stats.total_assets).toBe(400);
    expect(stats.by_type.ecs).toBe(28);
  });

  it("reflects tables and schema via describeTables and describeColumns (API fallback)", async () => {
    const client = new CmdbClient(baseConfig, silentLogger, async () => new Response("{}", { status: 404 }));
    
    const tables = await client.describeTables();
    expect(tables.total).toBeGreaterThan(3);
    expect(tables.tables.map((t) => t.table_name)).toContain("assets");
    expect(tables.tables.map((t) => t.table_name)).toContain("tenants");

    const columns = await client.describeColumns({ table_name: "assets" });
    expect(columns.table_name).toBe("assets");
    expect(columns.columns.length).toBeGreaterThan(5);
    expect(columns.columns.find((c) => c.column_name === "id")?.is_primary_key).toBe(true);
    expect(columns.columns.find((c) => c.column_name === "tenant_id")).toBeDefined();
  });
});


