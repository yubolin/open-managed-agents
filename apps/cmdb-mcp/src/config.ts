export interface CmdbMcpConfig {
  port: number;
  cmdbBaseUrl: string;
  cmdbApiToken?: string;
  cmdbUsername?: string;
  cmdbPassword?: string;
  cmdbAuthHeader: string;
  cmdbAuthScheme: string;
  cmdbDbUrl?: string;
  cmdbDbType?: "auto" | "postgres" | "mysql" | "sqlite";
  maxSqlRows: number;
  sqlTimeoutMs: number;
  ingressToken?: string;
  proxyUrl?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  requestTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CmdbMcpConfig {
  const port = parseInt(env.PORT || "3910", 10);
  const cmdbBaseUrl = (env.CMDB_BASE_URL || "").trim().replace(/\/+$/, "");
  const cmdbApiToken = (env.CMDB_API_TOKEN || "").trim() || undefined;
  const cmdbUsername = (env.CMDB_USERNAME || "").trim() || undefined;
  const cmdbPassword = (env.CMDB_PASSWORD || "").trim() || undefined;
  const cmdbAuthHeader = (env.CMDB_AUTH_HEADER || "Authorization").trim();
  const cmdbAuthScheme = (env.CMDB_AUTH_SCHEME !== undefined ? env.CMDB_AUTH_SCHEME : "Bearer").trim();
  const cmdbDbUrl = (env.CMDB_DB_URL || "").trim() || undefined;
  const rawDbType = (env.CMDB_DB_TYPE || "auto").toLowerCase();
  const cmdbDbType: CmdbMcpConfig["cmdbDbType"] =
    rawDbType === "postgres" || rawDbType === "mysql" || rawDbType === "sqlite"
      ? rawDbType
      : "auto";
  const maxSqlRows = parseInt(env.CMDB_SQL_MAX_ROWS || "200", 10);
  const sqlTimeoutMs = parseInt(env.CMDB_SQL_TIMEOUT_MS || "10000", 10);
  const ingressToken = (env.CMDB_MCP_INGRESS_TOKEN || "").trim() || undefined;
  const proxyUrl = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "").trim() || undefined;
  const rawLogLevel = (env.LOG_LEVEL || "info").toLowerCase();
  const logLevel: CmdbMcpConfig["logLevel"] =
    rawLogLevel === "debug" || rawLogLevel === "warn" || rawLogLevel === "error"
      ? rawLogLevel
      : "info";
  const requestTimeoutMs = parseInt(env.REQUEST_TIMEOUT_MS || "10000", 10);

  if (!cmdbBaseUrl) {
    throw new Error("Missing required environment variable: CMDB_BASE_URL");
  }

  // Must have one of: static token, username+password, or proxyUrl
  const hasUserPass = !!(cmdbUsername && cmdbPassword);
  if (!cmdbApiToken && !hasUserPass && !proxyUrl) {
    throw new Error(
      "Must provide either CMDB_API_TOKEN, (CMDB_USERNAME and CMDB_PASSWORD), or configure HTTPS_PROXY for Vault injection",
    );
  }

  return {
    port: isNaN(port) ? 3910 : port,
    cmdbBaseUrl,
    cmdbApiToken,
    cmdbUsername,
    cmdbPassword,
    cmdbAuthHeader,
    cmdbAuthScheme,
    cmdbDbUrl,
    cmdbDbType,
    maxSqlRows: isNaN(maxSqlRows) ? 200 : maxSqlRows,
    sqlTimeoutMs: isNaN(sqlTimeoutMs) ? 10000 : sqlTimeoutMs,
    ingressToken,
    proxyUrl,
    logLevel,
    requestTimeoutMs: isNaN(requestTimeoutMs) ? 10000 : requestTimeoutMs,
  };
}
