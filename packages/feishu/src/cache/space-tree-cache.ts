import type { FeishuApiClient, FeishuWikiSpace, FeishuWikiSpaceNode } from "../api/client";

export interface CachedWikiNode {
  spaceId: string;
  spaceName: string;
  nodeToken: string;
  objToken: string;
  objType: string;
  parentNodeToken: string;
  title: string;
  nodePath: string;
  hasChild: boolean;
}

export interface WikiNodeSearchHit {
  space_id: string;
  space_name: string;
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  node_path: string;
  has_child: boolean;
  score: number;
  matched_fields: Array<"title" | "path">;
}

export interface WikiSearchOptions {
  query: string;
  spaceId?: string;
  topK?: number;
  refreshCache?: boolean;
}

export interface WikiSearchResponse {
  ok: boolean;
  query: string;
  total_matched: number;
  results: WikiNodeSearchHit[];
  truncated: boolean;
  error?: string;
}

export interface FeishuSpaceTreeCacheOptions {
  /** Cache TTL in milliseconds. Defaults to 10 minutes (600,000ms). */
  ttlMs?: number;
  /** Clock function for testing. */
  nowMs?: () => number;
  /** Max concurrent node listing requests. Defaults to 5. */
  concurrency?: number;
}

export class FeishuSpaceTreeCache {
  private nodes: CachedWikiNode[] | null = null;
  private lastFetchedAt = 0;
  private inflight: Promise<CachedWikiNode[]> | null = null;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private readonly concurrency: number;

  constructor(opts: FeishuSpaceTreeCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.concurrency = opts.concurrency ?? 5;
  }

  /**
   * Set nodes directly (used for testing without HTTP layer).
   */
  setNodesForTesting(nodes: CachedWikiNode[]): void {
    this.nodes = nodes;
    this.lastFetchedAt = this.nowMs();
  }

  /**
   * Returns cached nodes or builds the tree afresh.
   * Concurrent callers share the same in-flight build promise.
   */
  async getOrBuildNodes(
    client: FeishuApiClient,
    forceRefresh = false,
  ): Promise<CachedWikiNode[]> {
    const now = this.nowMs();
    if (!forceRefresh && this.nodes && now - this.lastFetchedAt < this.ttlMs) {
      return this.nodes;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.crawlAllSpaces(client)
      .then((built) => {
        this.nodes = built;
        this.lastFetchedAt = this.nowMs();
        return built;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  /**
   * Fast fuzzy search across cached wiki nodes.
   */
  async search(
    client: FeishuApiClient,
    opts: WikiSearchOptions,
  ): Promise<WikiSearchResponse> {
    const query = opts.query.trim();
    if (!query) {
      return {
        ok: true,
        query: opts.query,
        total_matched: 0,
        results: [],
        truncated: false,
      };
    }

    try {
      const allNodes = await this.getOrBuildNodes(client, Boolean(opts.refreshCache));
      const targetNodes = opts.spaceId
        ? allNodes.filter((n) => n.spaceId === opts.spaceId)
        : allNodes;

      const hits: WikiNodeSearchHit[] = [];
      const queryLower = query.toLowerCase();

      for (const node of targetNodes) {
        const titleLower = node.title.toLowerCase();
        const pathLower = node.nodePath.toLowerCase();

        let score = 0;
        const matchedFields: Array<"title" | "path"> = [];

        if (titleLower === queryLower) {
          score += 100;
          matchedFields.push("title");
        } else if (titleLower.startsWith(queryLower)) {
          score += 80;
          matchedFields.push("title");
        } else if (titleLower.includes(queryLower)) {
          score += 60;
          matchedFields.push("title");
        }

        if (pathLower.includes(queryLower)) {
          if (!matchedFields.includes("title")) {
            score += 30;
          } else {
            score += 10;
          }
          matchedFields.push("path");
        }

        if (score > 0) {
          hits.push({
            space_id: node.spaceId,
            space_name: node.spaceName,
            node_token: node.nodeToken,
            obj_token: node.objToken,
            obj_type: node.objType,
            title: node.title,
            node_path: node.nodePath,
            has_child: node.hasChild,
            score,
            matched_fields: matchedFields,
          });
        }
      }

      // Sort by score DESC, then shorter title
      hits.sort((a, b) => b.score - a.score || a.title.length - b.title.length);

      const topK = Math.min(Math.max(opts.topK ?? 5, 1), 20);
      const totalMatched = hits.length;
      const truncated = totalMatched > topK;
      const results = hits.slice(0, topK);

      return {
        ok: true,
        query: opts.query,
        total_matched: totalMatched,
        results,
        truncated,
      };
    } catch (err) {
      return {
        ok: false,
        query: opts.query,
        total_matched: 0,
        results: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Crawl all spaces and their entire node hierarchies using bounded concurrency.
   */
  private async crawlAllSpaces(client: FeishuApiClient): Promise<CachedWikiNode[]> {
    const spaces: FeishuWikiSpace[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const res = await client.listWikiSpaces({ pageToken, pageSize: 50 });
      spaces.push(...res.items);
      pageToken = res.hasMore ? res.pageToken : undefined;
    } while (pageToken);

    const allNodes: CachedWikiNode[] = [];

    // Process spaces concurrently with limit
    await this.mapConcurrent(spaces, this.concurrency, async (space) => {
      const spaceNodes = await this.crawlSpaceNodes(space, client);
      allNodes.push(...spaceNodes);
    });

    return allNodes;
  }

  /**
   * Crawl all nodes within a single knowledge space, computing hierarchical paths.
   */
  private async crawlSpaceNodes(
    space: FeishuWikiSpace,
    client: FeishuApiClient,
  ): Promise<CachedWikiNode[]> {
    const rawNodesMap = new Map<string, FeishuWikiSpaceNode>();
    const parentToChildren = new Map<string, string[]>(); // parentToken -> childTokens[]

    // BFS queue for parent tokens to crawl. Root nodes have parentNodeToken = ""
    const queue: string[] = [""];

    while (queue.length > 0) {
      const batch = queue.splice(0, this.concurrency);

      await Promise.all(
        batch.map(async (parentNodeToken) => {
          let pageToken: string | undefined = undefined;

          do {
            const res = await client.listWikiSpaceNodes({
              spaceId: space.space_id,
              parentNodeToken: parentNodeToken || undefined,
              pageToken,
              pageSize: 50,
            });

            for (const node of res.items) {
              rawNodesMap.set(node.node_token, node);
              const pToken = node.parent_node_token || "";
              const children = parentToChildren.get(pToken) ?? [];
              children.push(node.node_token);
              parentToChildren.set(pToken, children);

              if (node.has_child) {
                queue.push(node.node_token);
              }
            }

            pageToken = res.hasMore ? res.pageToken : undefined;
          } while (pageToken);
        }),
      );
    }

    // Now assemble full hierarchical paths
    const cachedNodes: CachedWikiNode[] = [];

    const computePath = (nodeToken: string, parentPath: string): void => {
      const node = rawNodesMap.get(nodeToken);
      if (!node) return;

      const currentPath = parentPath
        ? `${parentPath} / ${node.title}`
        : `${space.name} / ${node.title}`;

      cachedNodes.push({
        spaceId: space.space_id,
        spaceName: space.name,
        nodeToken: node.node_token,
        objToken: node.obj_token,
        objType: node.obj_type,
        parentNodeToken: node.parent_node_token || "",
        title: node.title,
        nodePath: currentPath,
        hasChild: node.has_child,
      });

      const children = parentToChildren.get(nodeToken) ?? [];
      for (const childToken of children) {
        computePath(childToken, currentPath);
      }
    };

    // Root nodes
    const rootTokens = parentToChildren.get("") ?? [];
    for (const rootToken of rootTokens) {
      computePath(rootToken, "");
    }

    return cachedNodes;
  }

  /**
   * Helper to run async mapper with bounded concurrency.
   */
  private async mapConcurrent<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await fn(item);
        }
      }
    });
    await Promise.all(workers);
  }
}
