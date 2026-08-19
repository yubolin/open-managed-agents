#!/usr/bin/env tsx
// Attach the CMDB MCP server to AIOps digital employees and target agents.
//
// Usage:
//   BASE=http://localhost:8787 KEY=test-key tsx scripts/attach-cmdb-mcp.ts
//   CMDB_MCP_URL=http://oma-cmdb-mcp:3910/mcp tsx scripts/attach-cmdb-mcp.ts --all

const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.KEY ?? "test-key";
const CMDB_MCP_URL = process.env.CMDB_MCP_URL ?? "http://oma-cmdb-mcp:3910/mcp";
const ATTACH_ALL = process.argv.includes("--all");

const AIOPS_ROSTER = [
  "aiops-duty-supervisor",
  "aiops-expert-sre",
  "aiops-expert-network",
  "aiops-expert-db",
  "aiops-expert-security",
];

interface AgentRecord {
  id: string;
  name: string;
  version: number;
  model: unknown;
  system?: string;
  tools?: unknown[];
  skills?: unknown[];
  mcp_servers?: Array<{ name: string; type: string; url?: string; authorization_token?: string }>;
  callable_agents?: unknown[];
  metadata?: Record<string, unknown>;
}

async function main() {
  const headers = {
    "x-api-key": KEY,
    "content-type": "application/json",
  };

  console.log(`Connecting to OpenMA at ${BASE}...`);
  const listRes = await fetch(`${BASE}/v1/agents?limit=200`, { headers });
  if (!listRes.ok) {
    throw new Error(`GET /v1/agents failed: ${listRes.status} ${await listRes.text()}`);
  }

  const listBody = (await listRes.json()) as { data?: AgentRecord[] };
  const agents = listBody.data || [];

  console.log(`Found ${agents.length} agent(s).`);

  let updatedCount = 0;

  for (const agent of agents) {
    const isTarget = ATTACH_ALL || AIOPS_ROSTER.includes(agent.name);
    if (!isTarget) continue;

    const existingMcp = agent.mcp_servers || [];
    const hasCmdb = existingMcp.some((m) => m.name === "cmdb" || m.url === CMDB_MCP_URL);

    if (hasCmdb) {
      console.log(`= [${agent.name}] (${agent.id}) already has CMDB MCP attached`);
      continue;
    }

    const updatedMcp = [
      ...existingMcp,
      {
        name: "cmdb",
        type: "url",
        url: CMDB_MCP_URL,
      },
    ];

    const updateRes = await fetch(`${BASE}/v1/agents/${agent.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: agent.name,
        model: agent.model,
        system: agent.system ?? "",
        tools: agent.tools ?? [],
        skills: agent.skills,
        mcp_servers: updatedMcp,
        callable_agents: agent.callable_agents,
        metadata: agent.metadata,
      }),
    });

    if (!updateRes.ok) {
      console.error(`x Failed to update ${agent.name} (${agent.id}): ${updateRes.status} ${await updateRes.text()}`);
      continue;
    }

    console.log(`+ [${agent.name}] (${agent.id}) -> attached CMDB MCP (${CMDB_MCP_URL})`);
    updatedCount++;
  }

  console.log(`\nDone. Attached CMDB MCP to ${updatedCount} agent(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
