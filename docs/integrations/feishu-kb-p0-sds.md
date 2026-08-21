# 飞书知识库 P0 连接器 — SDS（sidecar + 应用身份）

> 状态：**v1.0（2026-08-21 全链路验收通过，已部署上线）**。
> 来源：对"独立只读 App + 专用服务账号 OAuth + lark-mcp `-t` 四工具"方案的评审修正与落地闭环。
> 定位：P0 是**指定团队知识空间连接器**（浏览已知空间与读取授权文档），不是"知识库搜索连接器"，
> 也不是"用户个人知识库连接器"。

---

## 1. 评审记录（对原方案的事实核查）

| # | 原方案主张 | 核查 | 证据 |
|---|-----------|------|------|
| 1 | 两个搜索工具均只支持用户身份 | ✅ 成立 | lark-mcp 源码：`wiki.v1.node.search`、`docx.builtin.search` 均 `accessTokens:['user']` |
| 2 | `preset.doc.default` 含写操作 | ✅ 成立 | 含 `docx.builtin.import`、`drive.v1.permissionMember.create` |
| 3 | （原方案漏）没有任何 preset 是只读的 | ⚠️ 补充 | `preset.light` 同样含 `docx.builtin.import`——`-t` 白名单是必要项 |
| 4 | App 身份可做已知链接解析/读取 | ✅ 成立 | `wiki.v2.space.getNode` 源码 `['tenant','user']` |
| 5 | scope `wiki:node:retrieve` | 🟡 名存实异 | 它是 nodes.list 端点的 granular scope（get_node 页写 `wiki:node:read`）；但两端点均接受 `wiki:wiki:readonly`，不影响收敛 |
| 6 | 用户 OAuth 可在服务端容器化 | ❌ 证伪 | 官方 docker.md："In Docker environment, OAuth mode does not support yet. Please use -u for user authentication."——`-u` 是短期 token，无自动轮换 |
| 7 | （原方案漏）无官方镜像 | ⚠️ 补充 | 官方只有本地 `docker build :latest`；npm latest = 0.5.1（Beta）→ 自建镜像必须锁版本 |
| 8 | scope `search:docs:read` 存在 | ✅ 成立 | 官方教程 FAQ 报错原文（P0 无搜索工具，暂不用） |

**四处修正**（已闭环）：
1. P0 凭证模型：服务账号 OAuth → **应用身份**（tenant_access_token，修正 #6）。
2. 工具面：搜索导向 → **浏览与直达导向** 4 工具（修正 #1 的推论——App 身份做不了全局搜索，聚焦已知节点与空间浏览）。
3. scope：4+1 → **2 个**：`wiki:wiki:readonly` + `docx:document:readonly`（管理后台开通，无 OAuth consent）。
4. 定位声明：团队知识空间连接器，非搜索/个人知识库连接器。

## 2. P0 架构与运行时环境

```
┌─────────────┐ Streamable HTTP ┌──────────────────┐ tenant_token ┌────────────┐
│  oma-server  │ ───────────────▶│  oma-lark-mcp     │ ────────────▶│ open.feishu.cn
│ (main-node)  │  /mcp (内网)     │ (官方 lark-mcp     │  (SDK 自管)   │  /open-apis
└─────────────┘                  │  0.5.1, 锁版本)    │              └────────────┘
      │                          └──────────────────┘
      │ mcp_servers[] 只存内网 URL（无凭证）
```

- **服务**：`oma-lark-mcp` sidecar（`docker-compose.yml` 与 `docker-compose.postgres.yml`）。
  自建镜像 `docker/lark-mcp/Dockerfile`，锁 `@larksuiteoapi/lark-mcp@0.5.1`。
- **多阶段构建与原生依赖**：
  `@larksuiteoapi/lark-mcp` 依赖 native module `keytar`；构建阶段引入 `python3`, `make`, `g++`, `libsecret-1-dev`, `pkg-config`，运行阶段精简并只保留 `libsecret-1-0`。
- **内存与 V8 堆配置**：
  lark-mcp 启动时需全量加载解析庞大的飞书 OpenAPI 规范定义，初始化阶段峰值内存较高。需配置：
  - 容器内存上限：`mem_limit: 1536m`（或至少 1G）；
  - V8 老生代上限：`NODE_OPTIONS=--max-old-space-size=1024`，防止启动期间 V8 堆溢出崩溃。
- **白名单与命令参数**：
  `CMD ["mcp", "-m", "streamable", "--host", "0.0.0.0", "-p", "3000", "-c", "snake", "--token-mode", "tenant_access_token", "-t", "wiki.v2.space.list,wiki.v2.spaceNode.list,wiki.v2.space.getNode,docx.v1.document.rawContent", "--config", "/run/secrets/lark-mcp-config"]`
  写在 Dockerfile CMD（git 可审计，改动即重建）。OMA harness 会全量注册远端返回的工具、无二阶 `enabled_tools` 过滤（`apps/agent/src/harness/tools.ts`），因此 `-t` 进程白名单与 `--token-mode tenant_access_token` 是**唯一**可靠的写隔离与应用身份边界。
- **server 名**：`feishu-kb`（工具名如 `mcp__feishu-kb__wiki_v2_space_list`）。
  不用 `feishu`——与内置 in-process 工具 `mcp__feishu__im_message_send/im_chat_read`（`apps/main-node/src/lib/feishu-agent-tools.ts`）仅名字相像、机制不同，撞名会造成提示词混淆。
- **不复用** `FeishuApiClient`（tenant-only、IM-only）；sidecar 用官方 lark-mcp。

### 工具面身份支持（源码与 0.5.1 实测核实）

| 上游 API / CLI 过滤名 | 实际暴露工具名 (snake) | OMA 工具全名 | accessTokens | 用途 |
|------|-------------|--------------|-------------|------|
| `wiki.v2.space.list` | `wiki_v2_space_list` | `mcp__feishu-kb__wiki_v2_space_list` | `['tenant','user']` | 列出应用作为成员可访问的知识空间 |
| `wiki.v2.spaceNode.list` | `wiki_v2_spaceNode_list` | `mcp__feishu-kb__wiki_v2_spaceNode_list` | `['tenant','user']` | 列空间子节点树 |
| `wiki.v2.space.getNode` | `wiki_v2_space_getNode` | `mcp__feishu-kb__wiki_v2_space_getNode` | `['tenant','user']` | 解析节点 Token 或 URL 链接，获取目标 `obj_token` 与 `obj_type` |
| `docx.v1.document.rawContent` | `docx_v1_document_rawContent` | `mcp__feishu-kb__docx_v1_document_rawContent` | `['tenant','user']` | 提取 docx 格式的完整纯文本正文 |

## 3. 凭证分层（P0）

```
App ID / App Secret → ./secrets/lark-mcp-config.json（docker secret 挂载，仅 sidecar 进程可读；
                       示例见 docker/lark-mcp/config.example.json；secrets/ 目录 gitignore）
tenant_access_token → lark-mcp SDK 运行时获取/缓存/过期重取，不持久化
用户 access/refresh  → P0 不使用
OMA Vault            → P0 不使用（多租户演进见 §6）
agent 侧             → mcp_servers 只存 http://oma-lark-mcp:3000/mcp，零凭证
```

- 不走 `-a/-s` 裸参（会漏在容器 `ps` 输出里），统一 `--config /run/secrets/lark-mcp-config`；
- **文件权限要求**：挂载的宿主机 `secrets/lark-mcp-config.json` 权限设为 `chmod 644`，确保容器内非 root 用户 `node`（uid 1000）具备读取权限。

## 4. 飞书侧配置（操作员）

1. **独立只读 App**（专用 App，不与 IM bot 混用）。
2. **权限开通**（权限管理中开通）：
   - `wiki:wiki:readonly`
   - `docx:document:readonly`
3. **版本发布**：在开放平台创建并发布包含上述权限的应用版本。
4. **知识空间/文档授权**（飞书 ACL 隔离）：
   - **整库访问**：空间设置 → 成员管理 → 添加该自建应用（`wiki_v2_space_list` 可枚举该空间）；
   - **单文档/节点授权**：文档右上角【Share（分享）】/【Manage Collaborators】中搜索该自建应用并赋予 `Can view` 只读权限（Agent 可通过 `wiki_v2_space_getNode` 直接直达读取）。

## 5. 边界与设计不变量

1. **P0 = 指定团队知识空间连接器**；非用户个人知识库连接器，非全局搜索连接器。
2. **仅 Node self-host/Compose**。CF runtime 够不着 compose 内网地址，**不宣称双运行时支持**。
3. **App 必须被显式授权**；飞书 ACL 不被 scope 绕过。
4. **当前限制说明**：Wiki 底层对象仅支持 `docx`；Sheet/Base/Slides 节点直接透传上游原始响应/错误（sidecar 与 harness 暂未做格式拦截转换）。
5. **镜像锁版本**（当前 0.5.1，Beta）；**禁止**运行时无锁 `npx -y ...@latest`。
6. **会话快照不变量**：根据平台会话不可变设计，Agent 挂载 MCP 服务后，必须**新建会话（New Session）** 才能生效。存量已创建会话保持历史冻结版本。

## 6. 挂载与运维操作

### 6.1 服务启动
```bash
cd /opt/openma
docker compose -f docker-compose.postgres.yml up -d --build oma-lark-mcp
```

### 6.2 Agent 批量挂载
使用 `scripts/attach-lark-mcp.ts`：
```bash
cd /opt/openma
BASE=http://localhost:8787 KEY=<operator-api-key> npx tsx scripts/attach-lark-mcp.ts --all
```
- 自动遍历 `next_cursor` 分页；
- PUT body 携带 `version`，具备 409 冲突重读重算防覆盖机制；
- 具备幂等性（若已挂载则输出 `= already has Feishu KB MCP attached`）。

---

## 7. 验收与实测证据（生产环境通过）

### 7.1 白名单与连通性验证
在 `oma-server` 容器内向 `http://oma-lark-mcp:3000/mcp` 发起 JSON-RPC 探测：
- `tools/list`：精确返回 4 个 snake_case 白名单工具（不多不少）；
- `tools/call`：对 `wiki_v2_space_list` 发起调用，成功通过 `tenant_access_token` 获取飞书 OpenAPI 响应：
  ```json
  {"has_more": false, "items": [], "page_token": "0||7641416818258807761"}
  ```

### 7.2 端到端 Agent 真实会话验证（2026-08-21 验证通过）
- **测试会话**：`sess-f3r35f5jpqys33ms`
- **输入问题**：`请帮我读取飞书知识库节点 GXDew0pyXiqBXGkT3LlcFijanlc 的内容并做个简要总结`
- **执行轨迹**：
  1. `agent.thinking`：识别到知识库节点 Token `GXDew0pyXiqBXGkT3LlcFijanlc`，调用 `mcp__feishu-kb__wiki_v2_space_getNode`；
  2. `agent.mcp_tool_result`：成功解析出节点对应 docx 文档 ID `RWSQd9JiWovIykxuYLScyV2anIf`（标题：《云服务BU-数智业务部-知识库》）；
  3. `agent.mcp_tool_use`：自动调用 `mcp__feishu-kb__docx_v1_document_rawContent` 获取完整正文；
  4. `agent.message`：准确提炼出《愿景和目标》、《Data+AI快速入口》、《知识治理能力图谱》三大核心板块摘要并结构化输出。
- **结论**：4 项验收准则全部达成，端到端链路完全闭环。
