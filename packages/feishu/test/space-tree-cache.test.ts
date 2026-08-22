import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest, HttpResponse } from "@open-managed-agents/integrations-core";
import { FeishuApiClient } from "../src/api/client";
import { FeishuSpaceTreeCache, type CachedWikiNode } from "../src/cache/space-tree-cache";

class FakeHttp implements HttpClient {
  public calls: HttpRequest[] = [];
  private routes: Array<{ match: (req: HttpRequest) => boolean; respond: (req: HttpRequest) => HttpResponse }> = [];
  private default: HttpResponse;

  constructor(defaultResponse: HttpResponse = { status: 200, headers: {}, body: "{}" }) {
    this.default = defaultResponse;
  }

  on(match: (req: HttpRequest) => boolean, respond: (req: HttpRequest) => HttpResponse): void {
    this.routes.push({ match, respond });
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const found = this.routes.find((r) => r.match(req));
    return found ? found.respond(req) : this.default;
  }
}

function ok<T>(data: T): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, msg: "ok", data }),
  };
}

describe("cache/space-tree-cache — FeishuSpaceTreeCache", () => {
  let http: FakeHttp;
  let client: FeishuApiClient;
  let cache: FeishuSpaceTreeCache;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    http = new FakeHttp();
    client = new FeishuApiClient(
      { appId: "cli_cache_test", appSecret: "secret_test", nowMs: () => NOW },
      http,
    );
    cache = new FeishuSpaceTreeCache({ ttlMs: 10 * 60 * 1000, nowMs: () => NOW });
  });

  it("builds multi-space tree with hierarchical node paths", async () => {
    // 1. Token mint
    http.on(
      (req) => req.url.includes("/auth/v3/tenant_access_token/internal"),
      () => ok({ tenant_access_token: "t-test", expire: 7200 }),
    );
    // 2. listWikiSpaces
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces") && !req.url.includes("/nodes"),
      () =>
        ok({
          items: [
            { space_id: "spc_arch", name: "Architecture KB" },
            { space_id: "spc_ops", name: "Operations KB" },
          ],
          has_more: false,
        }),
    );
    // 3. listWikiSpaceNodes (spc_arch root)
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces/spc_arch/nodes") && !req.url.includes("parent_node_token"),
      () =>
        ok({
          items: [
            {
              space_id: "spc_arch",
              node_token: "node_arch_root",
              obj_token: "doc_arch_root",
              obj_type: "docx",
              parent_node_token: "",
              title: "Harness Overview",
              has_child: true,
            },
            {
              space_id: "spc_arch",
              node_token: "node_arch_faq",
              obj_token: "doc_arch_faq",
              obj_type: "docx",
              parent_node_token: "",
              title: "FAQ",
              has_child: false,
            },
          ],
          has_more: false,
        }),
    );
    // 4. listWikiSpaceNodes (spc_arch child under node_arch_root)
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces/spc_arch/nodes") && req.url.includes("parent_node_token=node_arch_root"),
      () =>
        ok({
          items: [
            {
              space_id: "spc_arch",
              node_token: "node_arch_governance",
              obj_token: "doc_arch_governance",
              obj_type: "docx",
              parent_node_token: "node_arch_root",
              title: "Context Stability & Governance SDS",
              has_child: false,
            },
          ],
          has_more: false,
        }),
    );
    // 5. listWikiSpaceNodes (spc_ops root)
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces/spc_ops/nodes"),
      () =>
        ok({
          items: [
            {
              space_id: "spc_ops",
              node_token: "node_ops_deploy",
              obj_token: "doc_ops_deploy",
              obj_type: "docx",
              parent_node_token: "",
              title: "Deployment Playbook",
              has_child: false,
            },
          ],
          has_more: false,
        }),
    );

    const nodes = await cache.getOrBuildNodes(client);
    expect(nodes).toHaveLength(4);

    const govNode = nodes.find((n) => n.nodeToken === "node_arch_governance");
    expect(govNode).toBeDefined();
    expect(govNode?.nodePath).toBe(
      "Architecture KB / Harness Overview / Context Stability & Governance SDS",
    );
    expect(govNode?.objToken).toBe("doc_arch_governance");
    expect(govNode?.spaceName).toBe("Architecture KB");
  });

  it("searches nodes by title with relevance ranking", async () => {
    // Populate fake cached nodes directly
    const fakeNodes: CachedWikiNode[] = [
      {
        spaceId: "spc_1",
        spaceName: "Tech",
        nodeToken: "n_exact",
        objToken: "d_exact",
        objType: "docx",
        parentNodeToken: "",
        title: "SDS",
        nodePath: "Tech / SDS",
        hasChild: false,
      },
      {
        spaceId: "spc_1",
        spaceName: "Tech",
        nodeToken: "n_prefix",
        objToken: "d_prefix",
        objType: "docx",
        parentNodeToken: "",
        title: "SDS Specification Guide",
        nodePath: "Tech / SDS Specification Guide",
        hasChild: false,
      },
      {
        spaceId: "spc_1",
        spaceName: "Tech",
        nodeToken: "n_middle",
        objToken: "d_middle",
        objType: "docx",
        parentNodeToken: "",
        title: "Harness SDS v0.4",
        nodePath: "Tech / Harness SDS v0.4",
        hasChild: false,
      },
      {
        spaceId: "spc_1",
        spaceName: "Tech",
        nodeToken: "n_path_only",
        objToken: "d_path_only",
        objType: "docx",
        parentNodeToken: "n_middle",
        title: "Appendix A",
        nodePath: "Tech / Harness SDS v0.4 / Appendix A",
        hasChild: false,
      },
      {
        spaceId: "spc_1",
        spaceName: "Tech",
        nodeToken: "n_unrelated",
        objToken: "d_unrelated",
        objType: "docx",
        parentNodeToken: "",
        title: "Database Indexing",
        nodePath: "Tech / Database Indexing",
        hasChild: false,
      },
    ];

    cache.setNodesForTesting(fakeNodes);

    const res = await cache.search(client, { query: "sds", topK: 10 });
    expect(res.total_matched).toBe(4);
    expect(res.results).toHaveLength(4);

    // Exact title match ranks #1
    expect(res.results[0]?.node_token).toBe("n_exact");
    expect(res.results[0]?.score).toBeGreaterThan(res.results[1]!.score);

    // Prefix title match ranks #2
    expect(res.results[1]?.node_token).toBe("n_prefix");
    expect(res.results[1]?.score).toBeGreaterThan(res.results[2]!.score);

    // Middle title match ranks #3
    expect(res.results[2]?.node_token).toBe("n_middle");

    // Path match ranks #4
    expect(res.results[3]?.node_token).toBe("n_path_only");
    expect(res.results[3]?.matched_fields).toContain("path");
  });

  it("filters search results by space_id", async () => {
    cache.setNodesForTesting([
      {
        spaceId: "spc_alpha",
        spaceName: "Alpha",
        nodeToken: "n_1",
        objToken: "d_1",
        objType: "docx",
        parentNodeToken: "",
        title: "User Manual",
        nodePath: "Alpha / User Manual",
        hasChild: false,
      },
      {
        spaceId: "spc_beta",
        spaceName: "Beta",
        nodeToken: "n_2",
        objToken: "d_2",
        objType: "docx",
        parentNodeToken: "",
        title: "User Manual",
        nodePath: "Beta / User Manual",
        hasChild: false,
      },
    ]);

    const res = await cache.search(client, { query: "User Manual", spaceId: "spc_beta" });
    expect(res.total_matched).toBe(1);
    expect(res.results[0]?.space_id).toBe("spc_beta");
    expect(res.results[0]?.node_token).toBe("n_2");
  });

  it("respects top_k and sets truncated flag when more hits exist", async () => {
    const hits: CachedWikiNode[] = Array.from({ length: 15 }, (_, i) => ({
      spaceId: "spc_1",
      spaceName: "Docs",
      nodeToken: `n_${i}`,
      objToken: `d_${i}`,
      objType: "docx",
      parentNodeToken: "",
      title: `Document ${i} - Architecture Guide`,
      nodePath: `Docs / Document ${i} - Architecture Guide`,
      hasChild: false,
    }));
    cache.setNodesForTesting(hits);

    const res = await cache.search(client, { query: "Architecture", topK: 3 });
    expect(res.total_matched).toBe(15);
    expect(res.results).toHaveLength(3);
    expect(res.truncated).toBe(true);
  });

  it("handles empty query or no match gracefully", async () => {
    cache.setNodesForTesting([
      {
        spaceId: "spc_1",
        spaceName: "Docs",
        nodeToken: "n_1",
        objToken: "d_1",
        objType: "docx",
        parentNodeToken: "",
        title: "Overview",
        nodePath: "Docs / Overview",
        hasChild: false,
      },
    ]);

    const emptyRes = await cache.search(client, { query: "   " });
    expect(emptyRes.total_matched).toBe(0);
    expect(emptyRes.results).toEqual([]);
    expect(emptyRes.truncated).toBe(false);

    const noMatchRes = await cache.search(client, { query: "NonexistentKeyword123" });
    expect(noMatchRes.total_matched).toBe(0);
    expect(noMatchRes.results).toEqual([]);
  });

  it("rebuilds cache when refreshCache is true", async () => {
    let version = 1;
    http.on(
      (req) => req.url.includes("/auth/v3/tenant_access_token/internal"),
      () => ok({ tenant_access_token: "t-test", expire: 7200 }),
    );
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces") && !req.url.includes("/nodes"),
      () =>
        ok({
          items: [{ space_id: "spc_1", name: version === 1 ? "Old Space" : "New Space" }],
          has_more: false,
        }),
    );
    http.on(
      (req) => req.url.includes("/wiki/v2/spaces/spc_1/nodes"),
      () =>
        ok({
          items: [
            {
              space_id: "spc_1",
              node_token: version === 1 ? "n_old" : "n_new",
              obj_token: version === 1 ? "d_old" : "d_new",
              obj_type: "docx",
              parent_node_token: "",
              title: version === 1 ? "Old Doc" : "New Doc",
              has_child: false,
            },
          ],
          has_more: false,
        }),
    );

    const firstBuild = await cache.getOrBuildNodes(client);
    expect(firstBuild[0]?.title).toBe("Old Doc");

    // Advance version
    version = 2;

    const refreshed = await cache.search(client, { query: "New", refreshCache: true });
    expect(refreshed.total_matched).toBe(1);
    expect(refreshed.results[0]?.title).toBe("New Doc");
  });
});
