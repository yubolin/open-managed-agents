import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { CmdbClient } from "./cmdb-client.js";
import { createHttpServer } from "./http-server.js";
import { setGlobalDispatcher, ProxyAgent } from "undici";

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  if (config.proxyUrl) {
    logger.info(
      { op: "cmdb-mcp.proxy_enabled", proxy_url: config.proxyUrl },
      "Routing outbound CMDB traffic via Vault proxy",
    );
    setGlobalDispatcher(new ProxyAgent(config.proxyUrl));
  }

  logger.info(
    {
      op: "cmdb-mcp.startup",
      port: config.port,
      cmdb_base_url: config.cmdbBaseUrl,
      vault_proxy_enabled: !!config.proxyUrl,
      direct_token_configured: !!config.cmdbApiToken,
      ingress_auth_enabled: !!config.ingressToken,
    },
    "Starting CMDB MCP service...",
  );

  const client = new CmdbClient(config, logger);
  const server = createHttpServer(config, client, logger);

  server.listen(config.port, "0.0.0.0", () => {
    logger.info(
      { op: "cmdb-mcp.listening", address: "0.0.0.0", port: config.port },
      `CMDB MCP listening on http://0.0.0.0:${config.port}`,
    );
  });

  const shutdown = (sig: string) => {
    logger.info({ op: "cmdb-mcp.shutdown", signal: sig }, `Received ${sig}, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`Fatal error during startup: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
