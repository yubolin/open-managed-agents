export interface CmdbMcpConfig {
  port: number;
  cmdbBaseUrl: string;
  cmdbApiToken: string;
  cmdbAuthHeader: string;
  cmdbAuthScheme: string;
  ingressToken?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  requestTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CmdbMcpConfig {
  const port = parseInt(env.PORT || "3910", 10);
  const cmdbBaseUrl = (env.CMDB_BASE_URL || "").trim().replace(/\/+$/, "");
  const cmdbApiToken = (env.CMDB_API_TOKEN || "").trim();
  const cmdbAuthHeader = (env.CMDB_AUTH_HEADER || "Authorization").trim();
  const cmdbAuthScheme = (env.CMDB_AUTH_SCHEME !== undefined ? env.CMDB_AUTH_SCHEME : "Bearer").trim();
  const ingressToken = (env.CMDB_MCP_INGRESS_TOKEN || "").trim() || undefined;
  const rawLogLevel = (env.LOG_LEVEL || "info").toLowerCase();
  const logLevel: CmdbMcpConfig["logLevel"] =
    rawLogLevel === "debug" || rawLogLevel === "warn" || rawLogLevel === "error"
      ? rawLogLevel
      : "info";
  const requestTimeoutMs = parseInt(env.REQUEST_TIMEOUT_MS || "10000", 10);

  if (!cmdbBaseUrl) {
    throw new Error("Missing required environment variable: CMDB_BASE_URL");
  }
  if (!cmdbApiToken) {
    throw new Error("Missing required environment variable: CMDB_API_TOKEN");
  }

  return {
    port: isNaN(port) ? 3910 : port,
    cmdbBaseUrl,
    cmdbApiToken,
    cmdbAuthHeader,
    cmdbAuthScheme,
    ingressToken,
    logLevel,
    requestTimeoutMs: isNaN(requestTimeoutMs) ? 10000 : requestTimeoutMs,
  };
}
