#!/usr/bin/env tsx
// Attach the Feishu KB MCP server (oma-lark-mcp sidecar) to agents.
//
// Server name is "feishu-kb" (NOT "feishu" — the built-in in-process tools
// mcp__feishu__im_message_send / im_chat_read already use that prefix and are
// a different mechanism entirely). Tools surface as
// mcp__feishu-kb__wiki_v2_space_list etc.
//
// Usage:
//   BASE=http://localhost:8787 KEY=test-key tsx scripts/attach-lark-mcp.ts --all
//   AGENTS=aiops-duty-supervisor,aiops-expert-sre tsx scripts/attach-lark-mcp.ts
//   LARK_KB_MCP_URL=http://oma-lark-mcp:3000/mcp tsx scripts/attach-lark-mcp.ts --all
//
// Unlike scripts/attach-cmdb-mcp.ts, the PUT carries `version` (F6 etag
// contract: missing version → 428, stale → 409) and retries once on 409 with
// recomputed state based on the fresh row.

const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.KEY ?? "test-key";
const LARK_KB_MCP_URL = process.env.LARK_KB_MCP_URL ?? "http://oma-lark-mcp:3000/mcp";
const ATTACH_ALL = process.argv.includes("--all");
const ROSTER = (process.env.AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

async function fetchAgent(headers: Record<string, string>, id: string): Promise<AgentRecord> {
  const res = await fetch(`${BASE}/v1/agents/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`GET /v1/agents/${id} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as AgentRecord;
}

async function listAllAgents(headers: Record<string, string>): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  let cursor: string | undefined = undefined;
  while (true) {
    const url = new URL(`${BASE}/v1/agents`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      throw new Error(`GET /v1/agents failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: AgentRecord[]; next_cursor?: string | null };
    const items = body.data || [];
    agents.push(...items);
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return agents;
}

async function putAgent(
  headers: Record<string, string>,
  agent: AgentRecord,
  mcpServers: AgentRecord["mcp_servers"],
): Promise<Response> {
  return fetch(`${BASE}/v1/agents/${agent.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: agent.name,
      model: agent.model,
      system: agent.system ?? "",
      tools: agent.tools ?? [],
      skills: agent.skills,
      version: agent.version,
      mcp_servers: mcpServers,
      callable_agents: agent.callable_agents,
      metadata: agent.metadata,
    }),
  });
}

async function main() {
  if (!ATTACH_ALL && ROSTER.length === 0) {
    throw new Error("No target agents: pass --all or AGENTS=name1,name2");
  }

  const headers = {
    "x-api-key": KEY,
    "content-type": "application/json",
  };

  console.log(`Connecting to OpenMA at ${BASE}...`);
  const agents = await listAllAgents(headers);
  console.log(`Found ${agents.length} agent(s) across pagination.`);

  let updatedCount = 0;
  const matchedRoster = new Set<string>();

  for (const agent of agents) {
    const isTarget = ATTACH_ALL || ROSTER.includes(agent.name);
    if (!isTarget) continue;
    matchedRoster.add(agent.name);

    let current = await fetchAgent(headers, agent.id);
    let existingMcp = current.mcp_servers || [];
    const hasKb = existingMcp.some((m) => m.name === "feishu-kb" || m.url === LARK_KB_MCP_URL);

    if (hasKb) {
      console.log(`= [${current.name}] (${current.id}) already has Feishu KB MCP attached`);
      continue;
    }

    let updatedMcp = [...existingMcp, { name: "feishu-kb", type: "url", url: LARK_KB_MCP_URL }];
    let updateRes = await putAgent(headers, current, updatedMcp);

    // F6: stale version → 409 with the latest row; refetch and recompute to avoid overwriting concurrent edits.
    if (updateRes.status === 409) {
      current = await fetchAgent(headers, agent.id);
      existingMcp = current.mcp_servers || [];
      if (existingMcp.some((m) => m.name === "feishu-kb" || m.url === LARK_KB_MCP_URL)) {
        console.log(`= [${current.name}] (${current.id}) concurrently attached Feishu KB MCP`);
        continue;
      }
      updatedMcp = [...existingMcp, { name: "feishu-kb", type: "url", url: LARK_KB_MCP_URL }];
      updateRes = await putAgent(headers, current, updatedMcp);
    }

    if (!updateRes.ok) {
      console.error(
        `x Failed to update ${current.name} (${current.id}): ${updateRes.status} ${await updateRes.text()}`,
      );
      continue;
    }

    console.log(`+ [${current.name}] (${current.id}) -> attached Feishu KB MCP (${LARK_KB_MCP_URL})`);
    updatedCount++;
  }

  if (!ATTACH_ALL && ROSTER.length > 0) {
    const missing = ROSTER.filter((name) => !matchedRoster.has(name));
    if (missing.length > 0) {
      console.warn(`! Warning: Target agent(s) not found in system: ${missing.join(", ")}`);
    }
  }

  console.log(`\nDone. Attached Feishu KB MCP to ${updatedCount} agent(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

