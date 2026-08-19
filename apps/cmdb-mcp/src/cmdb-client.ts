import { z } from "zod";
import type { CmdbMcpConfig } from "./config.js";
import { defaultLogger, Logger } from "./logger.js";

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
  | "CMDB_RATE_LIMITED";

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

  constructor(
    config: CmdbMcpConfig,
    logger: Logger = defaultLogger,
    customFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.config = config;
    this.logger = logger;
    this.customFetch = customFetch;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const headerName = this.config.cmdbAuthHeader;
    const scheme = this.config.cmdbAuthScheme;
    const token = this.config.cmdbApiToken;

    // Only inject manual header if token is explicitly configured in env.
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

    const headers = this.buildHeaders();
    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

        const res = await this.customFetch(url.toString(), {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 401 || res.status === 403) {
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
    const entities = rawItems.map((r) => this.normalizeEntity(r));
    const total = listRes.total ?? entities.length;

    return {
      entities,
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
}
