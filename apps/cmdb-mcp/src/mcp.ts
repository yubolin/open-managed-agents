import { CMDB_TOOLS } from "./tools.js";
import { CmdbClient, CmdbClientError } from "./cmdb-client.js";
import { Logger } from "./logger.js";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "oma-cmdb-mcp", version: "0.1.0" } as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function jsonRpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

export async function handleMcpJsonRpc(
  req: JsonRpcRequest,
  client: CmdbClient,
  logger: Logger,
): Promise<{ status: number; body: JsonRpcResponse | null }> {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return {
      status: 400,
      body: jsonRpcError(req.id ?? null, -32600, "Invalid Request"),
    };
  }

  const id = req.id ?? null;

  // 1. Notification methods (no id or notification prefix)
  if (req.method.startsWith("notifications/")) {
    logger.debug({ method: req.method }, "MCP notification received");
    return { status: 204, body: null };
  }

  // 2. Initialize
  if (req.method === "initialize") {
    return {
      status: 200,
      body: jsonRpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "CMDB Knowledge Connector. Use these tools to query IT infrastructure assets, hosts, VMs, databases, and dependency relationships.",
      }),
    };
  }

  // 3. tools/list
  if (req.method === "tools/list") {
    return {
      status: 200,
      body: jsonRpcOk(id, { tools: CMDB_TOOLS }),
    };
  }

  // 4. tools/call
  if (req.method === "tools/call") {
    const params = (req.params || {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const toolName = params.name;
    const args = params.arguments || {};

    const start = Date.now();

    try {
      let resultData: unknown;

      switch (toolName) {
        case "get_entity": {
          resultData = await client.getEntity(args as Parameters<CmdbClient["getEntity"]>[0]);
          break;
        }
        case "search_entities": {
          resultData = await client.searchEntities(args as Parameters<CmdbClient["searchEntities"]>[0]);
          break;
        }
        case "get_relationships": {
          resultData = await client.getRelationships(args as Parameters<CmdbClient["getRelationships"]>[0]);
          break;
        }
        case "list_tenants": {
          resultData = await client.listTenants(args as Parameters<CmdbClient["listTenants"]>[0]);
          break;
        }
        case "list_asset_types": {
          resultData = await client.listAssetTypes(args as Parameters<CmdbClient["listAssetTypes"]>[0]);
          break;
        }
        case "get_asset_stats": {
          resultData = await client.getAssetStats(args as Parameters<CmdbClient["getAssetStats"]>[0]);
          break;
        }
        case "describe_tables": {
          resultData = await client.describeTables(args as Parameters<CmdbClient["describeTables"]>[0]);
          break;
        }
        case "describe_columns": {
          resultData = await client.describeColumns(args as Parameters<CmdbClient["describeColumns"]>[0]);
          break;
        }
        case "execute_read_only_sql": {
          resultData = await client.executeReadOnlySql(args as Parameters<CmdbClient["executeReadOnlySql"]>[0]);
          break;
        }
        default:
          return {
            status: 200,
            body: jsonRpcError(id, -32601, `Unknown tool: ${toolName}`),
          };
      }

      logger.info({ op: "tools.call", tool: toolName, duration_ms: Date.now() - start }, "Tool call succeeded");

      const toolResult: McpToolResult = {
        content: [{ type: "text", text: JSON.stringify(resultData, null, 2) }],
      };
      return { status: 200, body: jsonRpcOk(id, toolResult) };
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error({ op: "tools.call", tool: toolName, duration_ms: durationMs, err: String(err) }, "Tool call failed");

      if (err instanceof CmdbClientError) {
        const errorEnvelope = err.toEnvelope();
        const toolResult: McpToolResult = {
          content: [{ type: "text", text: JSON.stringify(errorEnvelope, null, 2) }],
          isError: true,
        };
        return { status: 200, body: jsonRpcOk(id, toolResult) };
      }

      const fallbackEnvelope = {
        error: {
          code: "CMDB_UPSTREAM_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      };
      const toolResult: McpToolResult = {
        content: [{ type: "text", text: JSON.stringify(fallbackEnvelope, null, 2) }],
        isError: true,
      };
      return { status: 200, body: jsonRpcOk(id, toolResult) };
    }
  }

  // 5. Method not found
  return {
    status: 200,
    body: jsonRpcError(id, -32601, `Method not found: ${req.method}`),
  };
}
