/**
 * SQL Safety Validator
 *
 * Enforces strict read-only execution constraints:
 * 1. Only allows SELECT, WITH (CTEs), EXPLAIN, SHOW, DESCRIBE statements.
 * 2. Forbids multi-statement execution (semicolons).
 * 3. Forbids DDL/DML mutation keywords (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, GRANT, etc.).
 * 4. Forbids filesystem access and privilege escalation functions (INTO OUTFILE, pg_read_file, etc.).
 * 5. Injects a safety LIMIT constraint if none is present in the query.
 */

export class SqlSafetyError extends Error {
  readonly code = "SQL_SAFETY_VIOLATION";
  constructor(message: string) {
    super(`SQL safety violation: ${message}`);
    this.name = "SqlSafetyError";
  }
}

// Keywords that must never appear as command verbs or clauses in read-only SQL
const FORBIDDEN_VERBS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "REPLACE",
  "GRANT",
  "REVOKE",
  "LOCK",
  "UNLOCK",
  "RENAME",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "SET",
  "RESET",
  "PRAGMA",
  "EXEC",
  "EXECUTE",
  "CALL",
  "COPY",
  "SHUTDOWN",
  "KILL",
];

const FORBIDDEN_PATTERNS = [
  /INTO\s+OUTFILE/i,
  /INTO\s+DUMPFILE/i,
  /LOAD\s+DATA/i,
  /LOAD_FILE\s*\(/i,
  /PG_READ_FILE\s*\(/i,
  /PG_WRITE_FILE\s*\(/i,
  /PG_EXEC\s*\(/i,
  /DBLINK\s*\(/i,
  /XP_CMDSHELL/i,
];

/**
 * Remove SQL comments and string literals to perform reliable token analysis
 * without false positives from string contents like 'drop table' inside a WHERE clause.
 */
function stripCommentsAndStrings(sql: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingleQuote) {
      if (char === "'" && sql[i - 1] !== "\\") {
        if (nextChar === "'") {
          // Escaped single quote
          i++;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"' && sql[i - 1] !== "\\") {
        if (nextChar === '"') {
          // Escaped double quote
          i++;
        } else {
          inDoubleQuote = false;
        }
      }
      continue;
    }

    // Check for comment starts
    if (char === "-" && nextChar === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === "#") {
      inLineComment = true;
      continue;
    }

    // Check for string starts
    if (char === "'") {
      inSingleQuote = true;
      result += " ";
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

export function validateReadOnlySql(
  rawSql: string,
  maxRows: number = 200,
): { safeSql: string; originalSql: string } {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new SqlSafetyError("SQL statement cannot be empty");
  }

  // 1. Check for dangerous patterns in raw SQL
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new SqlSafetyError(`Forbidden database function/pattern detected: ${pattern}`);
    }
  }

  // 2. Strip comments & string literals for structural analysis
  const skeleton = stripCommentsAndStrings(trimmed).trim();

  // 3. Multi-statement check: reject multiple queries separated by semicolons
  const statements = skeleton
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (statements.length > 1) {
    throw new SqlSafetyError(
      "Multiple SQL statements are not permitted (semicolon chaining detected)",
    );
  }

  // 4. Verify the statement begins with a read-only keyword
  const firstToken = skeleton.split(/\s+/)[0]?.toUpperCase() || "";
  const ALLOWED_START_TOKENS = ["SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC"];

  if (!ALLOWED_START_TOKENS.includes(firstToken)) {
    throw new SqlSafetyError(
      `Only read-only queries are permitted (must start with SELECT, WITH, EXPLAIN, SHOW, or DESCRIBE). Received: '${firstToken}'`,
    );
  }

  // 5. Token-level verification: no forbidden DDL/DML tokens outside strings
  const tokens = skeleton
    .split(/[\s,()=<>!+*/|&^%~]+/)
    .map((t) => t.toUpperCase())
    .filter(Boolean);

  for (const token of tokens) {
    if (FORBIDDEN_VERBS.includes(token)) {
      throw new SqlSafetyError(
        `Forbidden SQL verb '${token}' detected. Only read-only queries are allowed.`,
      );
    }
  }

  // 6. Automatic LIMIT injection: if query does not specify LIMIT or OFFSET, enforce maxRows
  let safeSql = trimmed.replace(/;\s*$/, "");
  const hasLimit = /\bLIMIT\s+\d+/i.test(skeleton);

  if (!hasLimit && (firstToken === "SELECT" || firstToken === "WITH")) {
    safeSql = `${safeSql} LIMIT ${maxRows}`;
  }

  return {
    safeSql,
    originalSql: trimmed,
  };
}
