import { describe, it, expect } from "vitest";
import { validateReadOnlySql, SqlSafetyError } from "../src/sql/safety.js";

describe("SQL Safety Validator", () => {
  it("allows safe SELECT queries and injects LIMIT if missing", () => {
    const res1 = validateReadOnlySql("SELECT * FROM assets", 100);
    expect(res1.safeSql).toBe("SELECT * FROM assets LIMIT 100");

    const res2 = validateReadOnlySql("SELECT id, instance_name FROM assets WHERE status = 'running' LIMIT 20");
    expect(res2.safeSql).toBe("SELECT id, instance_name FROM assets WHERE status = 'running' LIMIT 20");
  });

  it("allows complex multi-table JOINs and GROUP BY aggregations", () => {
    const sql = `
      SELECT 
        t.tenant_name,
        a.vendor,
        a.asset_type,
        COUNT(*) as total_count,
        SUM(CAST(a.attributes->>'memory_mb' AS INTEGER)) as total_memory
      FROM assets a
      JOIN tenants t ON t.tenant_id = a.tenant_id
      WHERE a.status = 'running'
      GROUP BY t.tenant_name, a.vendor, a.asset_type
      HAVING COUNT(*) > 1
      ORDER BY total_count DESC
    `;
    const res = validateReadOnlySql(sql, 200);
    expect(res.safeSql).toContain("LIMIT 200");
    expect(res.safeSql).toContain("GROUP BY");
  });

  it("allows WITH (CTEs) queries", () => {
    const sql = `
      WITH running_vms AS (
        SELECT id, tenant_id FROM assets WHERE asset_type = 'ecs' AND status = 'running'
      )
      SELECT tenant_id, COUNT(*) FROM running_vms GROUP BY tenant_id
    `;
    const res = validateReadOnlySql(sql, 50);
    expect(res.safeSql).toContain("LIMIT 50");
  });

  it("allows EXPLAIN and SHOW queries", () => {
    const res1 = validateReadOnlySql("EXPLAIN SELECT * FROM assets");
    expect(res1.safeSql).toContain("EXPLAIN SELECT * FROM assets");

    const res2 = validateReadOnlySql("SHOW TABLES");
    expect(res2.safeSql).toBe("SHOW TABLES");
  });

  it("rejects DML mutation verbs (INSERT, UPDATE, DELETE)", () => {
    expect(() => validateReadOnlySql("INSERT INTO assets (id) VALUES ('1')")).toThrowError(SqlSafetyError);
    expect(() => validateReadOnlySql("UPDATE assets SET status = 'deleted'")).toThrowError(SqlSafetyError);
    expect(() => validateReadOnlySql("DELETE FROM assets WHERE id = '1'")).toThrowError(SqlSafetyError);
  });

  it("rejects DDL mutation verbs (DROP, ALTER, CREATE, TRUNCATE)", () => {
    expect(() => validateReadOnlySql("DROP TABLE assets")).toThrowError(SqlSafetyError);
    expect(() => validateReadOnlySql("ALTER TABLE assets ADD COLUMN hacked text")).toThrowError(SqlSafetyError);
    expect(() => validateReadOnlySql("CREATE TABLE hacked (id int)")).toThrowError(SqlSafetyError);
    expect(() => validateReadOnlySql("TRUNCATE TABLE assets")).toThrowError(SqlSafetyError);
  });

  it("rejects semicolon multi-statement injection attempts", () => {
    expect(() => validateReadOnlySql("SELECT * FROM assets; DROP TABLE assets;")).toThrowError(
      SqlSafetyError,
    );
    expect(() => validateReadOnlySql("SELECT 1; UPDATE users SET role='admin';")).toThrowError(
      SqlSafetyError,
    );
  });

  it("does not false-positive on words inside string literals", () => {
    const sql = "SELECT * FROM assets WHERE instance_name = 'drop table' AND status = 'update_pending'";
    const res = validateReadOnlySql(sql, 100);
    expect(res.safeSql).toBe(`${sql} LIMIT 100`);
  });

  it("rejects file write/read injection patterns (INTO OUTFILE, pg_read_file)", () => {
    expect(() => validateReadOnlySql("SELECT * FROM assets INTO OUTFILE '/tmp/dump.txt'")).toThrowError(
      SqlSafetyError,
    );
    expect(() => validateReadOnlySql("SELECT pg_read_file('/etc/passwd')")).toThrowError(
      SqlSafetyError,
    );
  });
});
