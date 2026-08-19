export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const CMDB_TOOLS: ToolDescriptor[] = [
  {
    name: "get_entity",
    description: "Query a single CMDB entity/CI by its entity_id, hostname, or IP address.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Unique entity ID or cloud instance ID",
        },
        hostname: {
          type: "string",
          description: "Hostname or instance name of the CI",
        },
        ip: {
          type: "string",
          description: "Private or public IP address of the CI",
        },
      },
    },
  },
  {
    name: "search_entities",
    description: "Search for multiple CMDB entities/CIs by keyword, entity class, owner team, or tags.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Fuzzy search keyword (matches hostname, IP, ID, etc.)",
        },
        entity_class: {
          type: "string",
          description: "Filter by entity class (host, vm, container, database, middleware, network, k8s, service)",
        },
        owner_team: {
          type: "string",
          description: "Filter by project code or owner team name",
        },
        labels: {
          type: "object",
          description: "Key-value tags to filter by",
        },
        limit: {
          type: "integer",
          description: "Maximum number of records to return (default 20, max 100)",
        },
      },
    },
  },
  {
    name: "get_relationships",
    description: "Query upstream and downstream relationship dependencies for a given CMDB entity ID.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The source or target entity ID to inspect",
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description: "Relation direction: 'out' (downstream dependencies), 'in' (upstream callers), or 'both' (default)",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "list_tenants",
    description: "List all enterprise tenants registered in CMDB with their tenant ID, display name, and role.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keyword to filter tenants by name or ID",
        },
      },
    },
  },
  {
    name: "list_asset_types",
    description: "List all CI asset categories and ledger types available in CMDB (e.g. ecs, rds, vpc, security_group, oss, public_ip, certificate) with their asset class.",
    inputSchema: {
      type: "object",
      properties: {
        asset_class: {
          type: "string",
          enum: ["core", "platform"],
          description: "Filter by asset class: 'core' (compute/storage/network) or 'platform' (PaaS/governance)",
        },
      },
    },
  },
  {
    name: "get_asset_stats",
    description: "Get global aggregate statistics and breakdown counts of CMDB assets. Returns total asset count, counts by asset type (ecs, rds, etc.), counts by cloud vendor (aliyun, aws, azure), counts by status (running, stopped), and counts by region.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Optional tenant ID to filter stats for a specific tenant",
        },
        asset_type: {
          type: "string",
          description: "Optional asset type (e.g. 'ecs', 'rds', 'vpc') to count",
        },
        vendor: {
          type: "string",
          description: "Optional cloud vendor ('aliyun', 'aws', 'azure')",
        },
        status: {
          type: "string",
          description: "Optional status ('running', 'stopped', 'available')",
        },
      },
    },
  },
];
