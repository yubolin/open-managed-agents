import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const TARGET_TENANT_ID = process.env.TARGET_TENANT_ID || "tn_4cd3a7c940135088a94e728ee48f6fdf";
const TARGET_USER_ID = process.env.TARGET_USER_ID || "YE5UN3xx5fTNlP7Tc6qJF82FfNynFUOr";
const LOCAL_DB_PATH = path.resolve(
  fs.existsSync("apps/main-node/data/oma.db") ? "apps/main-node/data/oma.db" : "data/oma.db"
);

console.log(`Reading local database from: ${LOCAL_DB_PATH}`);
console.log(`Target Tenant ID: ${TARGET_TENANT_ID}`);
console.log(`Target User ID: ${TARGET_USER_ID}`);

function queryJson(sql: string): Record<string, any>[] {
  const cmd = `sqlite3 "${LOCAL_DB_PATH}" -json ${JSON.stringify(sql)}`;
  const out = execSync(cmd, { encoding: "utf8" }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function escapeSqlVal(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

function generateUpsertSql(
  tableName: string,
  conflictKey: string[],
  rows: Record<string, any>[]
): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const sqls: string[] = [];

  for (const row of rows) {
    const colNames = cols.map((c) => `"${c}"`).join(", ");
    const vals = cols.map((c) => escapeSqlVal(row[c])).join(", ");
    const updateSets = cols
      .filter((c) => !conflictKey.includes(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");

    const hasTenant = cols.includes("tenant_id");
    const conflictClause =
      conflictKey.length > 0
        ? hasTenant
          ? `ON CONFLICT (${conflictKey.map((k) => `"${k}"`).join(", ")}) DO UPDATE SET ${updateSets} WHERE "${tableName}"."tenant_id" = EXCLUDED."tenant_id"`
          : `ON CONFLICT (${conflictKey.map((k) => `"${k}"`).join(", ")}) DO NOTHING`
        : "ON CONFLICT DO NOTHING";

    sqls.push(`INSERT INTO "${tableName}" (${colNames}) VALUES (${vals}) ${conflictClause};`);
  }

  return sqls.join("\n");
}

const allSql: string[] = ["BEGIN;"];

// 1. model_cards
const rawModelCards = queryJson("SELECT * FROM model_cards");
const targetModelCards: Record<string, any>[] = [];
for (const card of rawModelCards) {
  // Target tenant model card with original ID preserved for agent references
  targetModelCards.push({
    ...card,
    tenant_id: TARGET_TENANT_ID,
    is_default: card.is_default ?? 1,
  });
}
allSql.push(
  "-- Model Cards",
  generateUpsertSql("model_cards", ["id"], targetModelCards)
);

// 2. environments
const envRows = queryJson("SELECT * FROM environments");
const targetEnvs = envRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Environments",
  generateUpsertSql("environments", ["id"], targetEnvs)
);

// 3. vaults
const vaultRows = queryJson("SELECT * FROM vaults");
const targetVaults = vaultRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Vaults",
  generateUpsertSql("vaults", ["id"], targetVaults)
);

// 4. service_templates & versions
const tmplRows = queryJson("SELECT * FROM service_templates");
const targetTmpls = tmplRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Service Templates",
  generateUpsertSql("service_templates", ["id"], targetTmpls)
);

const tmplVerRows = queryJson("SELECT * FROM service_template_versions");
const targetTmplVers = tmplVerRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Service Template Versions",
  generateUpsertSql("service_template_versions", ["template_id", "version"], targetTmplVers)
);

// 5. agents & agent_versions
const agentRows = queryJson("SELECT * FROM agents");
const targetAgents = agentRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Agents",
  generateUpsertSql("agents", ["id"], targetAgents)
);

const agentVerRows = queryJson("SELECT * FROM agent_versions");
const targetAgentVers = agentVerRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
}));
allSql.push(
  "-- Agent Versions",
  generateUpsertSql("agent_versions", ["agent_id", "version"], targetAgentVers)
);

// 6. feishu_installations & feishu_publications
const feishuInstRows = queryJson("SELECT * FROM feishu_installations");
const targetFeishuInsts = feishuInstRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
  user_id: TARGET_USER_ID,
}));
allSql.push(
  "-- Feishu Installations",
  generateUpsertSql("feishu_installations", ["id"], targetFeishuInsts)
);

const feishuPubRows = queryJson("SELECT * FROM feishu_publications");
const targetFeishuPubs = feishuPubRows.map((r) => ({
  ...r,
  tenant_id: TARGET_TENANT_ID,
  user_id: TARGET_USER_ID,
}));
allSql.push(
  "-- Feishu Publications",
  generateUpsertSql("feishu_publications", ["id"], targetFeishuPubs)
);

allSql.push("COMMIT;");

const finalSql = allSql.filter(Boolean).join("\n\n");
const sqlFilePath = path.resolve(".sync-data.sql");
fs.writeFileSync(sqlFilePath, finalSql, "utf8");
console.log(`Generated SQL to ${sqlFilePath} (${finalSql.length} bytes)`);

// Summary
console.log(`Summary of records to sync:`);
console.log(`- Model Cards: ${targetModelCards.length}`);
console.log(`- Environments: ${targetEnvs.length}`);
console.log(`- Vaults: ${targetVaults.length}`);
console.log(`- Service Templates: ${targetTmpls.length}`);
console.log(`- Agents: ${targetAgents.length}`);
console.log(`- Agent Versions: ${targetAgentVers.length}`);
console.log(`- Feishu Installations: ${targetFeishuInsts.length}`);
console.log(`- Feishu Publications: ${targetFeishuPubs.length}`);
