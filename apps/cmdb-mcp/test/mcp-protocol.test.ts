import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { createHttpServer } from "../src/http-server.js";
import { CmdbClient } from "../src/cmdb-client.js";
import { Logger } from "../src/logger.js";
import type { CmdbMcpConfig } from "../src/config.js";

describe("MCP Protocol End-to-End with @ai-sdk/mcp", () => {
  let server: http.Server;
  let serverUrl: string;
  const silentLogger = new Logger("error");

  const mockEntities = [
    {
      id: "srv-001",
      instance_id: "i-001",
      instance_name: "prod-web-01",
      asset_type: "ecs",
      attributes: { private_ip: "10.0.21.50" },
      tags: { env: "prod" },
    },
  ];

  const mockRelations = [
    {
      source_id: "srv-001",
      target_id: "rds-001",
      relation_type: "depends_on",
    },
  ];

  const mockFetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/v1/assets/srv-001")) {
      return new Response(JSON.stringify(mockEntities[0]), { status: 200 });
    }
    if (url.pathname === "/api/v1/assets/") {
      const q = url.searchParams.get("query");
      if (q === "nonexistent") {
        return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: mockEntities, total: 1 }), { status: 200 });
    }
    if (url.pathname === "/api/v1/relations/") {
      if (url.searchParams.get("source_id") === "srv-001") {
        return new Response(JSON.stringify({ items: mockRelations, total: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
  };

  const testConfig: CmdbMcpConfig = {
    port: 0,
    cmdbBaseUrl: "https://cmdb.local",
    cmdbApiToken: "mock-token",
    cmdbAuthHeader: "Authorization",
    cmdbAuthScheme: "Bearer",
    logLevel: "error",
    requestTimeoutMs: 2000,
  };

  beforeAll(async () => {
    const client = new CmdbClient(testConfig, silentLogger, mockFetch);
    server = createHttpServer(testConfig, client, silentLogger);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("handles initialization, tools/list, and tools/call using real createMCPClient", async () => {
    const mcpClient = await experimental_createMCPClient({
      transport: {
        type: "http",
        url: serverUrl,
      },
      name: "test-client",
    });

    const tools = await mcpClient.tools();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["get_entity", "search_entities", "get_relationships"]),
    );

    // Call get_entity
    const getEntityTool = tools["get_entity"];
    expect(getEntityTool).toBeDefined();

    const entityResult = (await getEntityTool.execute({
      entity_id: "srv-001",
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(entityResult.isError).toBeFalsy();
    expect(entityResult.content).toHaveLength(1);
    const parsedEntity = JSON.parse(entityResult.content[0].text);
    expect(parsedEntity.entity.entity_id).toBe("srv-001");
    expect(parsedEntity.entity.hostname).toBe("prod-web-01");

    // Call search_entities
    const searchTool = tools["search_entities"];
    const searchResult = (await searchTool.execute({
      query: "prod-web",
    })) as { content: Array<{ type: string; text: string }> };

    const parsedSearch = JSON.parse(searchResult.content[0].text);
    expect(parsedSearch.entities).toHaveLength(1);
    expect(parsedSearch.total).toBe(1);

    // Call get_relationships
    const relTool = tools["get_relationships"];
    const relResult = (await relTool.execute({
      entity_id: "srv-001",
    })) as { content: Array<{ type: string; text: string }> };

    const parsedRel = JSON.parse(relResult.content[0].text);
    expect(parsedRel.relationships).toHaveLength(1);
    expect(parsedRel.relationships[0].relation).toBe("depends_on");
  });

  it("returns structured error envelope on business failure (isError: true)", async () => {
    const mcpClient = await experimental_createMCPClient({
      transport: {
        type: "http",
        url: serverUrl,
      },
      name: "test-client-errors",
    });

    const tools = await mcpClient.tools();
    const getEntityTool = tools["get_entity"];

    const res = (await getEntityTool.execute({
      entity_id: "nonexistent",
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBe(true);
    const envelope = JSON.parse(res.content[0].text);
    expect(envelope.error).toBeDefined();
    expect(envelope.error.code).toBe("CMDB_NOT_FOUND");
    expect(envelope.error.retryable).toBe(false);
  });

  it("enforces optional ingress token", async () => {
    const authedConfig: CmdbMcpConfig = {
      ...testConfig,
      ingressToken: "ingress-secret-999",
    };
    const authedClient = new CmdbClient(authedConfig, silentLogger, mockFetch);
    const authedServer = createHttpServer(authedConfig, authedClient, silentLogger);

    await new Promise<void>((resolve) => authedServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = authedServer.address() as AddressInfo;
    const authedUrl = `http://127.0.0.1:${addr.port}/mcp`;

    try {
      // 1. Without auth header -> 401
      const unauthRes = await fetch(authedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(unauthRes.status).toBe(401);

      // 2. With valid auth header -> 200
      const authRes = await fetch(authedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer ingress-secret-999",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(authRes.status).toBe(200);
      const data = await authRes.json();
      expect(data.result.tools).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => authedServer.close(() => resolve()));
    }
  });
});
