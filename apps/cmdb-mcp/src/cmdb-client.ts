import { z } from "zod";
import type { CmdbMcpConfig } from "./config.js";
import { defaultLogger, Logger } from "./logger.js";
import { SqlEngine } from "./sql/db.js";
import { SchemaReflector } from "./sql/schema.js";
import { VirtualSqliteDb } from "./sql/virtual-sqlite.js";

export type EntityClass =
  | "host"
  | "vm"
  | "container"
  | "database"
  | "middleware"
  | "network"
  | "k8s"
  | "service"
  | "unknown";

export interface CmdbEntity {
  entity_id: string;
  entity_class: EntityClass;
  hostname?: string;
  ips?: string[];
  owner_team?: string;
  labels?: Record<string, string>;
  raw?: unknown;
}

export type RelationType =
  | "runs_on"
  | "depends_on"
  | "connects_to"
  | "part_of"
  | "unknown";

export interface CmdbRelationship {
  from_entity_id: string;
  to_entity_id: string;
  relation: RelationType;
}

export type CmdbErrorCode =
  | "CMDB_AUTH_FAILED"
  | "CMDB_NOT_FOUND"
  | "CMDB_VALIDATION"
  | "CMDB_BAD_RESPONSE"
  | "CMDB_UPSTREAM_TIMEOUT"
  | "CMDB_UPSTREAM_UNAVAILABLE"
  | "CMDB_RATE_LIMITED"
  | "CMDB_DB_NOT_CONFIGURED";

export class CmdbClientError extends Error {
  constructor(
    public readonly code: CmdbErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CmdbClientError";
  }

  toEnvelope() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export class CmdbClient {
  private config: CmdbMcpConfig;
  private logger: Logger;
  private customFetch: typeof globalThis.fetch;
  private sqlEngine?: SqlEngine;
  private schemaReflector?: SchemaReflector;
  private virtualSqlite: VirtualSqliteDb;

  private dynamicAccessToken?: string;
  private dynamicRefreshToken?: string;
  private tokenExpiresAt: number = 0;

  constructor(
    config: CmdbMcpConfig,
    logger: Logger = defaultLogger,
    customFetch: typeof globalThis.fetch = globalThis.fetch,
    sqlEngine?: SqlEngine,
  ) {
    this.config = config;
    this.logger = logger;
    this.customFetch = customFetch;
    this.virtualSqlite = new VirtualSqliteDb(this.logger);

    if (sqlEngine) {
      this.sqlEngine = sqlEngine;
      this.schemaReflector = new SchemaReflector(this.sqlEngine);
    } else if (this.config.cmdbDbUrl) {
      this.sqlEngine = new SqlEngine({
        connectionUrl: this.config.cmdbDbUrl,
        dbType: this.config.cmdbDbType,
        maxRows: this.config.maxSqlRows,
        timeoutMs: this.config.sqlTimeoutMs,
        logger: this.logger,
      });
      this.schemaReflector = new SchemaReflector(this.sqlEngine);
    }
  }

  private async ensureToken(): Promise<string | undefined> {
    if (this.config.cmdbApiToken) {
      return this.config.cmdbApiToken;
    }
    if (!this.config.cmdbUsername || !this.config.cmdbPassword) {
      return undefined; // Proxy mode (oma-vault)
    }

    const now = Date.now();
    if (this.dynamicAccessToken && this.tokenExpiresAt > now + 30_000) {
      return this.dynamicAccessToken;
    }

    // Try refresh first if we have a refresh token
    if (this.dynamicRefreshToken) {
      try {
        const refreshUrl = new URL(this.config.cmdbBaseUrl + "/api/v1/auth/refresh");
        const res = await this.customFetch(refreshUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ refresh_token: this.dynamicRefreshToken }),
        });
        if (res.ok) {
          const data = (await res.json()) as { access_token: string; refresh_token?: string };
          this.dynamicAccessToken = data.access_token;
          if (data.refresh_token) this.dynamicRefreshToken = data.refresh_token;
          this.tokenExpiresAt = Date.now() + 3600_000;
          return this.dynamicAccessToken;
        }
      } catch (err) {
        this.logger.warn({ op: "auth.refresh_failed", err: String(err) }, "Token refresh failed, falling back to login");
      }
    }

    // Full login with username and password
    const loginUrl = new URL(this.config.cmdbBaseUrl + "/api/v1/auth/login");
    const loginRes = await this.customFetch(loginUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username: this.config.cmdbUsername,
        password: this.config.cmdbPassword,
      }),
    });

    if (!loginRes.ok) {
      throw new CmdbClientError(
        "CMDB_AUTH_FAILED",
        `Admin login failed with status ${loginRes.status}`,
        false,
      );
    }

    const loginData = (await loginRes.json()) as {
      access_token: string;
      refresh_token?: string;
      is_super_admin?: boolean;
      tenant_name?: string;
    };
    this.dynamicAccessToken = loginData.access_token;
    this.dynamicRefreshToken = loginData.refresh_token;
    this.tokenExpiresAt = Date.now() + 3600_000;

    this.logger.info(
      {
        op: "auth.login_ok",
        username: this.config.cmdbUsername,
        is_super_admin: loginData.is_super_admin,
        tenant: loginData.tenant_name,
      },
      "Logged in to CMDB successfully as admin",
    );

    return this.dynamicAccessToken;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const headerName = this.config.cmdbAuthHeader;
    const scheme = this.config.cmdbAuthScheme;
    const token = await this.ensureToken();

    // Only inject manual header if token is available.
    // If empty (Vault proxy mode), the outbound request leaves clean and oma-vault transparently injects it.
    if (token) {
      if (scheme) {
        headers[headerName] = `${scheme} ${token}`;
      } else {
        headers[headerName] = token;
      }
    }
    return headers;
  }

  private async request<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const url = new URL(this.config.cmdbBaseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = await this.buildHeaders();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

        const res = await this.customFetch(url.toString(), {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 401 || res.status === 403) {
          // If we are using username/password, invalidate dynamic token so next attempt re-authenticates
          if (this.config.cmdbUsername && attempt < maxAttempts) {
            this.dynamicAccessToken = undefined;
            this.logger.warn({ path, status: res.status }, "Auth failed with cached token, re-logging in...");
            continue;
          }
          throw new CmdbClientError(
            "CMDB_AUTH_FAILED",
            `Authentication failed with status ${res.status}`,
            false,
          );
        }
        if (res.status === 404) {
          throw new CmdbClientError("CMDB_NOT_FOUND", `Resource not found at ${path}`, false);
        }
        if (res.status === 429) {
          throw new CmdbClientError(
            "CMDB_RATE_LIMITED",
            "Rate limited by upstream CMDB API",
            true,
          );
        }
        if (res.status >= 500) {
          const body = await res.text().catch(() => "");
          if (attempt < maxAttempts) {
            this.logger.warn({ path, attempt, status: res.status }, "CMDB 5xx, retrying...");
            continue;
          }
          throw new CmdbClientError(
            "CMDB_UPSTREAM_UNAVAILABLE",
            `Upstream CMDB server error: ${res.status}`,
            true,
            body,
          );
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new CmdbClientError(
            "CMDB_UPSTREAM_UNAVAILABLE",
            `Upstream request failed with status ${res.status}`,
            false,
            body,
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof CmdbClientError) {
          throw err;
        }

        const isTimeout =
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("timeout"));

        if (attempt < maxAttempts && !isTimeout) {
          this.logger.warn({ path, attempt, err: String(err) }, "Fetch error, retrying...");
          continue;
        }

        if (isTimeout) {
          throw new CmdbClientError(
            "CMDB_UPSTREAM_TIMEOUT",
            `Request to CMDB timed out after ${this.config.requestTimeoutMs}ms`,
            true,
          );
        }

        throw new CmdbClientError(
          "CMDB_UPSTREAM_UNAVAILABLE",
          `Failed to connect to CMDB: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    }

    throw lastError;
  }

  // ─── Normalizers ──────────────────────────────────────────────────────────

  private normalizeClass(rawType?: string | null, rawClass?: string | null): EntityClass {
    const s = `${rawClass || ""} ${rawType || ""}`.toLowerCase();
    if (s.includes("host") || s.includes("server") || s.includes("pm") || s.includes("node")) return "host";
    if (s.includes("ecs") || s.includes("cvm") || s.includes("vm") || s.includes("instance") || s.includes("virtual")) return "vm";
    if (s.includes("container") || s.includes("pod") || s.includes("docker")) return "container";
    if (s.includes("rds") || s.includes("db") || s.includes("mysql") || s.includes("redis") || s.includes("database")) return "database";
    if (s.includes("slb") || s.includes("alb") || s.includes("nginx") || s.includes("mq") || s.includes("kafka") || s.includes("middleware")) return "middleware";
    if (s.includes("vpc") || s.includes("subnet") || s.includes("switch") || s.includes("router") || s.includes("network") || s.includes("eip")) return "network";
    if (s.includes("k8s") || s.includes("kubernetes") || s.includes("cluster")) return "k8s";
    if (s.includes("app") || s.includes("service") || s.includes("microservice")) return "service";
    return "unknown";
  }

  private normalizeRelation(rel?: string | null): RelationType {
    const s = (rel || "").toLowerCase().replace(/[\s_-]+/g, "_");
    if (s.includes("run") || s.includes("host")) return "runs_on";
    if (s.includes("depend") || s.includes("require")) return "depends_on";
    if (s.includes("connect") || s.includes("link") || s.includes("call")) return "connects_to";
    if (s.includes("part") || s.includes("belong") || s.includes("child") || s.includes("member")) return "part_of";
    return "unknown";
  }

  private normalizeEntity(raw: Record<string, unknown>): CmdbEntity {
    const id = String(raw.id || raw.asset_id || raw.instance_id || "");
    const instanceId = raw.instance_id ? String(raw.instance_id) : undefined;
    const instanceName = raw.instance_name ? String(raw.instance_name) : undefined;
    const rawAttrs = (raw.attributes && typeof raw.attributes === "object" ? raw.attributes : {}) as Record<string, unknown>;
    const rawTags = (raw.tags && typeof raw.tags === "object" ? raw.tags : {}) as Record<string, unknown>;

    const ips: string[] = [];
    if (rawAttrs.private_ip) ips.push(String(rawAttrs.private_ip));
    if (rawAttrs.public_ip) ips.push(String(rawAttrs.public_ip));
    if (rawAttrs.ip) ips.push(String(rawAttrs.ip));
    if (Array.isArray(rawAttrs.ips)) ips.push(...rawAttrs.ips.map(String));
    if (Array.isArray(rawAttrs.ip_addresses)) ips.push(...rawAttrs.ip_addresses.map(String));

    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawTags)) {
      if (v !== undefined && v !== null) labels[k] = String(v);
    }

    const ownerTeam = raw.cost_allocation_name
      ? String(raw.cost_allocation_name)
      : raw.project_code
        ? String(raw.project_code)
        : undefined;

    const hostname = instanceName || (rawAttrs.hostname ? String(rawAttrs.hostname) : undefined);

    return {
      entity_id: id || instanceId || hostname || "unknown",
      entity_class: this.normalizeClass(raw.asset_type as string, raw.asset_class as string),
      ...(hostname ? { hostname } : {}),
      ...(ips.length ? { ips: Array.from(new Set(ips)) } : {}),
      ...(ownerTeam ? { owner_team: ownerTeam } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
      raw,
    };
  }

  // ─── Public Tool Methods ──────────────────────────────────────────────────

  async getEntity(query: { entity_id?: string; hostname?: string; ip?: string }): Promise<{ entity: CmdbEntity; source: "cmdb" }> {
    const { entity_id, hostname, ip } = query;
    if (!entity_id && !hostname && !ip) {
      throw new CmdbClientError("CMDB_VALIDATION", "Must provide entity_id, hostname, or ip", false);
    }

    // 1. Direct ID lookup
    if (entity_id) {
      try {
        const raw = await this.request<Record<string, unknown>>(`/api/v1/assets/${encodeURIComponent(entity_id)}`);
        return { entity: this.normalizeEntity(raw), source: "cmdb" };
      } catch (err) {
        // If 404 by ID, fall through to search by query
        if (!(err instanceof CmdbClientError && err.code === "CMDB_NOT_FOUND")) {
          throw err;
        }
      }
    }

    // 2. Search query for hostname, ip, or fallback entity_id
    const q = hostname || ip || entity_id || "";
    const listRes = await this.request<{ items?: Array<Record<string, unknown>>; total?: number }>(
      "/api/v1/assets/",
      { query: q, page_size: 5 },
    );

    const items = listRes.items || [];
    if (items.length === 0) {
      throw new CmdbClientError("CMDB_NOT_FOUND", `No entity found matching ${q}`, false);
    }

    return { entity: this.normalizeEntity(items[0]), source: "cmdb" };
  }

  async searchEntities(opts: {
    query?: string;
    entity_class?: string;
    labels?: Record<string, string>;
    owner_team?: string;
    limit?: number;
  }): Promise<{ entities: CmdbEntity[]; total: number; truncated: boolean }> {
    const limit = Math.min(Math.max(opts.limit || 20, 1), 100);

    const queryParams: Record<string, string | number | boolean | undefined> = {
      query: opts.query,
      asset_type: opts.entity_class,
      page_size: limit,
      page: 1,
    };

    if (opts.owner_team) {
      queryParams.project_code = opts.owner_team;
    }

    const listRes = await this.request<{ items?: Array<Record<string, unknown>>; total?: number }>(
      "/api/v1/assets/",
      queryParams,
    );

    const rawItems = listRes.items || [];
    const entities = rawItems.map((r) => {
      const e = this.normalizeEntity(r);
      return {
        entity_id: e.entity_id,
        entity_class: e.entity_class,
        hostname: e.hostname,
        ips: e.ips,
        owner_team: e.owner_team,
        labels: e.labels,
        status: typeof r.status === "string" ? r.status : undefined,
        vendor: typeof r.vendor === "string" ? r.vendor : undefined,
        tenant_id: typeof r.tenant_id === "string" ? r.tenant_id : undefined,
      };
    });
    const total = listRes.total ?? entities.length;

    return {
      entities: entities as CmdbEntity[],
      total,
      truncated: total > entities.length,
    };
  }

  async getRelationships(opts: {
    entity_id: string;
    direction?: "out" | "in" | "both";
  }): Promise<{ relationships: CmdbRelationship[] }> {
    const entityId = opts.entity_id;
    if (!entityId) {
      throw new CmdbClientError("CMDB_VALIDATION", "entity_id is required", false);
    }

    const dir = opts.direction || "both";
    const relations: CmdbRelationship[] = [];

    if (dir === "out" || dir === "both") {
      try {
        const outRes = await this.request<{ items?: Array<Record<string, unknown>> }>(
          "/api/v1/relations/",
          { source_id: entityId, page_size: 100 },
        );
        for (const item of outRes.items || []) {
          relations.push({
            from_entity_id: String(item.source_id || entityId),
            to_entity_id: String(item.target_id || ""),
            relation: this.normalizeRelation(item.relation_type as string),
          });
        }
      } catch (err) {
        if (!(err instanceof CmdbClientError && err.code === "CMDB_NOT_FOUND")) {
          throw err;
        }
      }
    }

    if (dir === "in" || dir === "both") {
      try {
        const inRes = await this.request<{ items?: Array<Record<string, unknown>> }>(
          "/api/v1/relations/",
          { target_id: entityId, page_size: 100 },
        );
        for (const item of inRes.items || []) {
          relations.push({
            from_entity_id: String(item.source_id || ""),
            to_entity_id: String(item.target_id || entityId),
            relation: this.normalizeRelation(item.relation_type as string),
          });
        }
      } catch (err) {
        if (!(err instanceof CmdbClientError && err.code === "CMDB_NOT_FOUND")) {
          throw err;
        }
      }
    }

    return { relationships: relations };
  }

  async listTenants(opts?: { query?: string }): Promise<{
    tenants: Array<{ tenant_id: string; tenant_name: string; role?: string }>;
    total: number;
  }> {
    const rawList = await this.request<
      Array<{ tenant_id: string; tenant_name: string; role?: string }>
    >("/api/v1/auth/tenants");

    let tenants = Array.isArray(rawList) ? rawList : [];

    if (opts?.query) {
      const q = opts.query.toLowerCase();
      tenants = tenants.filter(
        (t) =>
          t.tenant_id.toLowerCase().includes(q) ||
          (t.tenant_name && t.tenant_name.toLowerCase().includes(q)),
      );
    }

    return {
      tenants,
      total: tenants.length,
    };
  }

  async listAssetTypes(opts?: { asset_class?: "core" | "platform" }): Promise<{
    types: Array<{ type: string; asset_class: string }>;
    total: number;
  }> {
    const raw = await this.request<{
      items?: string[];
      options?: Array<{ value: string; asset_class: string }>;
    }>("/api/v1/assets/types");

    let types: Array<{ type: string; asset_class: string }> = [];

    if (raw.options && Array.isArray(raw.options)) {
      types = raw.options.map((o) => ({
        type: o.value,
        asset_class: o.asset_class || "platform",
      }));
    } else if (raw.items && Array.isArray(raw.items)) {
      types = raw.items.map((t) => ({
        type: t,
        asset_class: "platform",
      }));
    }

    if (opts?.asset_class) {
      types = types.filter((t) => t.asset_class === opts.asset_class);
    }

    return {
      types,
      total: types.length,
    };
  }

  async getAssetStats(opts?: {
    tenant_id?: string;
    asset_type?: string;
    vendor?: string;
    status?: string;
  }): Promise<Record<string, unknown>> {
    // If specific filters are provided (e.g. single tenant or single asset_type), query /api/v1/assets/ count
    if (opts?.tenant_id || opts?.asset_type || opts?.vendor || opts?.status) {
      const queryParams: Record<string, string | number | boolean | undefined> = {
        page_size: 1,
        page: 1,
      };
      if (opts.tenant_id) queryParams.tenant_id = opts.tenant_id;
      if (opts.asset_type) queryParams.asset_type = opts.asset_type;
      if (opts.vendor) queryParams.vendor = opts.vendor;
      if (opts.status) queryParams.status = opts.status;

      const filtered = await this.request<{ total?: number; items?: unknown[] }>(
        "/api/v1/assets/",
        queryParams,
      );

      return {
        filter: opts,
        count: filtered.total ?? 0,
      };
    }

    // Global stats from /api/v1/dashboard/stats
    const dashboard = await this.request<Record<string, unknown>>("/api/v1/dashboard/stats");
    return dashboard;
  }

  async describeTables(opts?: { query?: string }): Promise<{
    tables: Array<{ table_name: string; table_comment?: string; estimated_rows?: number }>;
    total: number;
    source: "database" | "api_metadata";
  }> {
    if (this.schemaReflector) {
      const res = await this.schemaReflector.describeTables(opts?.query);
      return { ...res, source: "database" };
    }

    // Fallback: build virtual table ledger list from CMDB API
    let tables = [
      { table_name: "assets", table_comment: "CMDB 基础设施与资产主表 (云主机、IP、数据库、网络等400+项CI)", estimated_rows: 400 },
      { table_name: "relations", table_comment: "CMDB 资产拓扑与依赖调用关系表", estimated_rows: 187 },
      { table_name: "tenants", table_comment: "企业租户信息表", estimated_rows: 33 },
      { table_name: "projects", table_comment: "项目空间与成本归属表", estimated_rows: 10 },
      { table_name: "tickets", table_comment: "CMDB 关联运维与审批工单表", estimated_rows: 32 },
      { table_name: "cloud_credentials", table_comment: "多云账号与同步凭据表 (AWS, Azure, Aliyun)", estimated_rows: 5 },
      { table_name: "governance_reports", table_comment: "资产治理、闲置分析与数据质量审计表", estimated_rows: 50 },
    ];

    if (opts?.query) {
      const q = opts.query.toLowerCase();
      tables = tables.filter(
        (t) =>
          t.table_name.toLowerCase().includes(q) ||
          (t.table_comment && t.table_comment.toLowerCase().includes(q)),
      );
    }

    return {
      tables,
      total: tables.length,
      source: "api_metadata",
    };
  }

  async describeColumns(opts: { table_name: string }): Promise<{
    table_name: string;
    table_comment?: string;
    columns: Array<{
      column_name: string;
      data_type: string;
      is_nullable: boolean;
      column_comment?: string;
      is_primary_key?: boolean;
    }>;
    sample_attributes?: string[];
    source: "database" | "api_metadata";
  }> {
    if (this.schemaReflector) {
      const res = await this.schemaReflector.describeColumns(opts.table_name);
      return { ...res, source: "database" };
    }

    // Fallback schema for common CMDB tables
    const tableName = opts.table_name.toLowerCase();

    if (tableName === "assets") {
      return {
        table_name: "assets",
        table_comment: "CMDB 基础设施资产表",
        columns: [
          { column_name: "id", data_type: "varchar(64)", is_nullable: false, is_primary_key: true, column_comment: "资产唯一 UUID" },
          { column_name: "tenant_id", data_type: "varchar(64)", is_nullable: false, column_comment: "所属企业租户 ID" },
          { column_name: "instance_name", data_type: "varchar(255)", is_nullable: true, column_comment: "主机名/实例名称" },
          { column_name: "asset_type", data_type: "varchar(64)", is_nullable: false, column_comment: "资产类别 (ecs, rds, public_ip, vpc, security_group, oss 等)" },
          { column_name: "asset_class", data_type: "varchar(32)", is_nullable: true, column_comment: "核心/平台分级 (core, platform)" },
          { column_name: "vendor", data_type: "varchar(32)", is_nullable: false, column_comment: "云厂商 (aliyun, aws, azure)" },
          { column_name: "status", data_type: "varchar(32)", is_nullable: false, column_comment: "运行状态 (running, stopped, available)" },
          { column_name: "region", data_type: "varchar(64)", is_nullable: true, column_comment: "云区域/地域" },
          { column_name: "cloud_account", data_type: "varchar(64)", is_nullable: true, column_comment: "云账号名称" },
          { column_name: "project_code", data_type: "varchar(64)", is_nullable: true, column_comment: "所属项目编号" },
          { column_name: "cost_allocation_name", data_type: "varchar(128)", is_nullable: true, column_comment: "成本中心/团队名称" },
          { column_name: "attributes", data_type: "json / jsonb", is_nullable: true, column_comment: "规格属性 JSON (含 cpu_cores, memory_mb, private_ip, sku 等)" },
          { column_name: "tags", data_type: "json / jsonb", is_nullable: true, column_comment: "业务标签 Key-Value JSON" },
          { column_name: "created_at", data_type: "timestamp", is_nullable: false, column_comment: "创建时间" },
          { column_name: "updated_at", data_type: "timestamp", is_nullable: true, column_comment: "最后更新时间" },
        ],
        sample_attributes: ["cpu_cores", "memory_mb", "private_ip", "public_ip", "sku", "instance_type", "resource_group", "subscription_id"],
        source: "api_metadata",
      };
    }

    if (tableName === "relations") {
      return {
        table_name: "relations",
        table_comment: "CMDB 资产关系表",
        columns: [
          { column_name: "id", data_type: "varchar(64)", is_nullable: false, is_primary_key: true, column_comment: "关系记录唯一 ID" },
          { column_name: "source_id", data_type: "varchar(64)", is_nullable: false, column_comment: "源资产 ID / instance_id" },
          { column_name: "target_id", data_type: "varchar(64)", is_nullable: false, column_comment: "目标资产 ID / instance_id" },
          { column_name: "relation_type", data_type: "varchar(64)", is_nullable: false, column_comment: "关系类型 (depends_on, connects_to, contains, manages)" },
          { column_name: "created_at", data_type: "timestamp", is_nullable: false, column_comment: "创建时间" },
        ],
        source: "api_metadata",
      };
    }

    if (tableName === "tenants") {
      return {
        table_name: "tenants",
        table_comment: "企业租户表",
        columns: [
          { column_name: "tenant_id", data_type: "varchar(64)", is_nullable: false, is_primary_key: true, column_comment: "租户唯一标识" },
          { column_name: "tenant_name", data_type: "varchar(128)", is_nullable: false, column_comment: "企业租户显示名称" },
          { column_name: "role", data_type: "varchar(32)", is_nullable: true, column_comment: "权限角色 (admin, user)" },
        ],
        source: "api_metadata",
      };
    }

    throw new CmdbClientError("CMDB_NOT_FOUND", `Table '${tableName}' not found in CMDB schema`, false);
  }

  async executeReadOnlySql(opts: {
    sql: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    if (this.sqlEngine) {
      const res = await this.sqlEngine.executeQuery(opts.sql, opts.limit);
      return res as unknown as Record<string, unknown>;
    }

    // In API mode, execute seamlessly against in-memory virtual SQLite synced from CMDB API
    await this.virtualSqlite.ensureSynced(this);
    const res = this.virtualSqlite.executeQuery(opts.sql, opts.limit);
    return res as unknown as Record<string, unknown>;
  }
}

