import http from "node:http";
import type { CmdbMcpConfig } from "./config.js";
import { CmdbClient } from "./cmdb-client.js";
import { handleMcpJsonRpc, jsonRpcError, type JsonRpcRequest } from "./mcp.js";
import { Logger } from "./logger.js";

export function createHttpServer(
  config: CmdbMcpConfig,
  client: CmdbClient,
  logger: Logger,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // 1. Healthcheck
    if (pathname === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "oma-cmdb-mcp" }));
      return;
    }

    // 2. Reject non-POST on /mcp
    if (pathname === "/mcp") {
      if (method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      // Ingress Token validation (if configured)
      if (config.ingressToken) {
        const authHeader = req.headers["authorization"] || "";
        const expected = `Bearer ${config.ingressToken}`;
        if (authHeader !== expected) {
          logger.warn({ op: "ingress.auth_failed" }, "Unauthorized ingress request");
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      // Buffer incoming JSON-RPC request body
      let bodyStr = "";
      req.setEncoding("utf8");

      req.on("data", (chunk) => {
        bodyStr += chunk;
        if (bodyStr.length > 5 * 1024 * 1024) {
          // 5MB limit
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large" }));
          req.destroy();
        }
      });

      req.on("end", async () => {
        let jsonRpcReq: JsonRpcRequest;
        try {
          jsonRpcReq = JSON.parse(bodyStr) as JsonRpcRequest;
        } catch {
          const errRes = jsonRpcError(null, -32700, "Parse error");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(errRes));
          return;
        }

        try {
          const { status, body } = await handleMcpJsonRpc(jsonRpcReq, client, logger);
          if (status === 204 || body === null) {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        } catch (err) {
          logger.error({ op: "http.unhandled_error", err: String(err) }, "Unhandled error handling JSON-RPC");
          const errRes = jsonRpcError(jsonRpcReq.id ?? null, -32603, "Internal server error");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(errRes));
        }
      });

      return;
    }

    // 3. Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  return server;
}
