import pg from "pg";
import mysql from "mysql2/promise";
import { validateReadOnlySql } from "./safety.js";
import { Logger, defaultLogger } from "../logger.js";

export interface SqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  duration_ms: number;
  sql_executed: string;
}

export type DatabaseType = "postgres" | "mysql" | "sqlite";

export interface SqlEngineOptions {
  connectionUrl: string;
  dbType?: "auto" | DatabaseType;
  maxRows?: number;
  timeoutMs?: number;
  logger?: Logger;
}

export class SqlEngine {
  private connectionUrl: string;
  private dbType: DatabaseType;
  private maxRows: number;
  private timeoutMs: number;
  private logger: Logger;

  private pgPool?: pg.Pool;
  private mysqlPool?: mysql.Pool;

  constructor(opts: SqlEngineOptions) {
    this.connectionUrl = opts.connectionUrl;
    this.maxRows = opts.maxRows || 200;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.logger = opts.logger || defaultLogger;

    this.dbType = this.resolveDbType(opts.connectionUrl, opts.dbType);
  }

  private resolveDbType(url: string, explicitType?: "auto" | DatabaseType): DatabaseType {
    if (explicitType && explicitType !== "auto") {
      return explicitType;
    }
    const lower = url.toLowerCase();
    if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
      return "postgres";
    }
    if (lower.startsWith("mysql://") || lower.startsWith("mariadb://")) {
      return "mysql";
    }
    if (lower.startsWith("sqlite://") || lower.endsWith(".db") || lower.endsWith(".sqlite")) {
      return "sqlite";
    }
    return "postgres"; // default assumption
  }

  getDbType(): DatabaseType {
    return this.dbType;
  }

  private getPgPool(): pg.Pool {
    if (!this.pgPool) {
      this.pgPool = new pg.Pool({
        connectionString: this.connectionUrl,
        statement_timeout: this.timeoutMs,
        query_timeout: this.timeoutMs,
        max: 5,
        idleTimeoutMillis: 30000,
      });
    }
    return this.pgPool;
  }

  private getMysqlPool(): mysql.Pool {
    if (!this.mysqlPool) {
      this.mysqlPool = mysql.createPool({
        uri: this.connectionUrl,
        connectTimeout: this.timeoutMs,
        connectionLimit: 5,
        idleTimeout: 30000,
      });
    }
    return this.mysqlPool;
  }

  async executeQuery(rawSql: string, customLimit?: number): Promise<SqlQueryResult> {
    const limit = Math.min(Math.max(customLimit || this.maxRows, 1), 1000);
    const { safeSql } = validateReadOnlySql(rawSql, limit);

    const start = Date.now();

    if (this.dbType === "postgres") {
      const pool = this.getPgPool();
      const res = await pool.query(safeSql);
      const durationMs = Date.now() - start;

      const columns = res.fields ? res.fields.map((f) => f.name) : [];
      const rows = res.rows as Record<string, unknown>[];

      this.logger.info(
        { op: "sql.execute_ok", db_type: "postgres", row_count: rows.length, duration_ms: durationMs },
        "Executed read-only PostgreSQL query",
      );

      return {
        columns,
        rows,
        row_count: rows.length,
        duration_ms: durationMs,
        sql_executed: safeSql,
      };
    }

    if (this.dbType === "mysql") {
      const pool = this.getMysqlPool();
      const [rowsData, fields] = await pool.query(safeSql);
      const durationMs = Date.now() - start;

      const columns = Array.isArray(fields) ? fields.map((f) => f.name) : [];
      const rows = Array.isArray(rowsData) ? (rowsData as Record<string, unknown>[]) : [];

      this.logger.info(
        { op: "sql.execute_ok", db_type: "mysql", row_count: rows.length, duration_ms: durationMs },
        "Executed read-only MySQL query",
      );

      return {
        columns,
        rows,
        row_count: rows.length,
        duration_ms: durationMs,
        sql_executed: safeSql,
      };
    }

    throw new Error(`Unsupported database type: ${this.dbType}`);
  }

  async close(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = undefined;
    }
    if (this.mysqlPool) {
      await this.mysqlPool.end();
      this.mysqlPool = undefined;
    }
  }
}
