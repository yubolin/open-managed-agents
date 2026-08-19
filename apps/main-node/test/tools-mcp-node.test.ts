import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { createNodeMcpFetch } from "../src/lib/node-mcp-fetch.js";

describe("Node self-host MCP tools via mcpFetch", () => {
  let server: http.Server;
  let serverUrl: string;
  let lastAuthHeader: string | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuthHeader = req.headers["authorization"] || null;
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "test-mcp", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                tools: [
                  {
                    name: "echo",
                    description: "Echo back message",
                    inputSchema: {
                      type: "object",
                      properties: { msg: { type: "string" } },
                      required: ["msg"],
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                content: [{ type: "text", text: `echoed: ${parsed.params?.arguments?.msg}` }],
              },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const mockAgentConfig = {
    name: "test-agent",
    model: "claude-sonnet-4-6",
    system: "You are a test agent.",
    tools: [],
    mcp_servers: [
      {
        name: "mockservice",
        type: "url",
        url: "", // filled in tests
        authorization_token: "token-abc-123",
      },
    ],
  };

  it("registers mcp__<server>__<tool> when mcpFetch is provided", async () => {
    const config = {
      ...mockAgentConfig,
      mcp_servers: [{ ...mockAgentConfig.mcp_servers[0], url: serverUrl }],
    };

    const nodeFetch = createNodeMcpFetch();
    const tools = await buildTools(config as never, null as never, {
      mcpFetch: nodeFetch,
    });

    expect(tools["mcp__mockservice__echo"]).toBeDefined();

    const result = (await (tools["mcp__mockservice__echo"] as { execute: (args: unknown) => Promise<unknown> }).execute({
      msg: "hello node mcp",
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toBe("echoed: hello node mcp");
    expect(lastAuthHeader).toBe("Bearer token-abc-123");
  });

  it("silently skips MCP tools when both mcpBinding and mcpFetch are absent (regression guard)", async () => {
    const config = {
      ...mockAgentConfig,
      mcp_servers: [{ ...mockAgentConfig.mcp_servers[0], url: serverUrl }],
    };

    const tools = await buildTools(config as never, null as never, {});
    expect(tools["mcp__mockservice__echo"]).toBeUndefined();
  });
});
