import { SqlEngine } from "./db.js";

export interface TableSummary {
  table_name: string;
  table_comment?: string;
  estimated_rows?: number;
}

export interface ColumnDefinition {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default?: string;
  column_comment?: string;
  is_primary_key?: boolean;
}

export interface TableDetails {
  table_name: string;
  table_comment?: string;
  columns: ColumnDefinition[];
  sample_attributes?: string[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class SchemaReflector {
  private engine: SqlEngine;
  private tablesCache?: CacheEntry<TableSummary[]>;
  private columnsCache: Map<string, CacheEntry<TableDetails>> = new Map();
  private cacheTtlMs: number;

  constructor(engine: SqlEngine, cacheTtlMs: number = 300_000) {
    this.engine = engine;
    this.cacheTtlMs = cacheTtlMs;
  }

  async describeTables(query?: string): Promise<{ tables: TableSummary[]; total: number }> {
    const now = Date.now();
    let tables: TableSummary[] = [];

    if (this.tablesCache && this.tablesCache.expiresAt > now) {
      tables = this.tablesCache.data;
    } else {
      const dbType = this.engine.getDbType();

      if (dbType === "postgres") {
        const sql = `
          SELECT 
            t.table_name,
            obj_description(c.oid, 'pg_class') as table_comment,
            c.reltuples::bigint as estimated_rows
          FROM information_schema.tables t
          JOIN pg_class c ON c.relname = t.table_name
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
          WHERE t.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name ASC
        `;
        const res = await this.engine.executeQuery(sql, 500);
        tables = res.rows.map((r) => ({
          table_name: String(r.table_name),
          table_comment: r.table_comment ? String(r.table_comment) : undefined,
          estimated_rows: typeof r.estimated_rows === "number" || typeof r.estimated_rows === "bigint" || typeof r.estimated_rows === "string" ? Number(r.estimated_rows) : undefined,
        }));
      } else if (dbType === "mysql") {
        const sql = `
          SELECT 
            TABLE_NAME as table_name,
            TABLE_COMMENT as table_comment,
            TABLE_ROWS as estimated_rows
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME ASC
        `;
        const res = await this.engine.executeQuery(sql, 500);
        tables = res.rows.map((r) => ({
          table_name: String(r.table_name),
          table_comment: r.table_comment ? String(r.table_comment) : undefined,
          estimated_rows: typeof r.estimated_rows === "number" ? r.estimated_rows : undefined,
        }));
      }

      this.tablesCache = {
        data: tables,
        expiresAt: now + this.cacheTtlMs,
      };
    }

    if (query) {
      const q = query.toLowerCase();
      tables = tables.filter(
        (t) =>
          t.table_name.toLowerCase().includes(q) ||
          (t.table_comment && t.table_comment.toLowerCase().includes(q)),
      );
    }

    return {
      tables,
      total: tables.length,
    };
  }

  async describeColumns(tableName: string): Promise<TableDetails> {
    const cleanTable = tableName.trim().replace(/[^a-zA-Z0-9_]/g, "");
    if (!cleanTable) {
      throw new Error("Invalid table name provided");
    }

    const now = Date.now();
    const cached = this.columnsCache.get(cleanTable);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const dbType = this.engine.getDbType();
    let columns: ColumnDefinition[] = [];
    let tableComment: string | undefined;

    if (dbType === "postgres") {
      const sql = `
        SELECT 
          cols.column_name,
          cols.data_type,
          cols.is_nullable,
          cols.column_default,
          col_description(c.oid, cols.ordinal_position::int) as column_comment,
          (
            SELECT true 
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu 
              ON tc.constraint_name = kcu.constraint_name 
              AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' 
              AND tc.table_name = cols.table_name 
              AND kcu.column_name = cols.column_name
            LIMIT 1
          ) as is_pk
        FROM information_schema.columns cols
        JOIN pg_class c ON c.relname = cols.table_name
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = cols.table_schema
        WHERE cols.table_schema = 'public'
          AND cols.table_name = '${cleanTable}'
        ORDER BY cols.ordinal_position ASC
      `;
      const res = await this.engine.executeQuery(sql, 200);
      columns = res.rows.map((r) => ({
        column_name: String(r.column_name),
        data_type: String(r.data_type),
        is_nullable: String(r.is_nullable).toUpperCase() === "YES",
        column_default: r.column_default ? String(r.column_default) : undefined,
        column_comment: r.column_comment ? String(r.column_comment) : undefined,
        is_primary_key: !!r.is_pk,
      }));
    } else if (dbType === "mysql") {
      const sql = `
        SELECT 
          COLUMN_NAME as column_name,
          COLUMN_TYPE as data_type,
          IS_NULLABLE as is_nullable,
          COLUMN_DEFAULT as column_default,
          COLUMN_COMMENT as column_comment,
          COLUMN_KEY as column_key
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = '${cleanTable}'
        ORDER BY ORDINAL_POSITION ASC
      `;
      const res = await this.engine.executeQuery(sql, 200);
      columns = res.rows.map((r) => ({
        column_name: String(r.column_name),
        data_type: String(r.data_type),
        is_nullable: String(r.is_nullable).toUpperCase() === "YES",
        column_default: r.column_default ? String(r.column_default) : undefined,
        column_comment: r.column_comment ? String(r.column_comment) : undefined,
        is_primary_key: r.column_key === "PRI",
      }));
    }

    // Check for JSON attributes field and sample common keys if assets table
    let sampleAttributes: string[] | undefined;
    if (cleanTable.toLowerCase().includes("asset")) {
      sampleAttributes = [
        "cpu_cores",
        "memory_mb",
        "private_ip",
        "public_ip",
        "sku",
        "instance_type",
        "resource_group",
        "subscription_id",
      ];
    }

    const details: TableDetails = {
      table_name: cleanTable,
      table_comment: tableComment,
      columns,
      sample_attributes: sampleAttributes,
    };

    this.columnsCache.set(cleanTable, {
      data: details,
      expiresAt: now + this.cacheTtlMs,
    });

    return details;
  }
}
