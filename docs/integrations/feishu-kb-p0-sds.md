# 飞书知识库 P0 连接器 — SDS（sidecar + 应用身份）

> 状态：v0.1（2026-08-21 owner 拍板 P0 形态）。
> 来源：对"独立只读 App + 专用服务账号 OAuth + lark-mcp `-t` 四工具"方案的评审修正。
> 定位：P0 是**指定团队知识空间连接器**（浏览已知空间），不是"知识库搜索连接器"，
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

**四处修正**（已回执）：
1. P0 凭证模型：服务账号 OAuth → **应用身份**（tenant_access_token，修正 #6）。
2. 工具面：搜索导向 → **浏览导向** 4 工具（修正 #1 的推论——App 身份做不了搜索，就先不做搜索）。
3. scope：4+1 → **2 个**：`wiki:wiki:readonly` + `docx:document:readonly`（管理后台开通，无 OAuth consent）。
4. 定位声明：团队知识空间连接器，非搜索/个人知识库连接器。

## 2. P0 架构

```
┌─────────────┐ Streamable HTTP ┌──────────────────┐ tenant_token ┌────────────┐
│  oma-server  │ ───────────────▶│  oma-lark-mcp     │ ────────────▶│ open.feishu.cn
│ (main-node)  │  /mcp (内网)     │ (官方 lark-mcp     │  (SDK 自管)   │  /open-apis
└─────────────┘                  │  0.5.1, 锁版本)    │              └────────────┘
      │                          └──────────────────┘
      │ mcp_servers[] 只存内网 URL（无凭证）
```

- **服务**：`oma-lark-mcp` sidecar（docker-compose.yml 与 docker-compose.postgres.yml）。
  自建镜像 `docker/lark-mcp/Dockerfile`，锁 `@larksuiteoapi/lark-mcp@0.5.1`。
- **白名单与命令参数**：
  `CMD ["mcp", "-m", "streamable", "--host", "0.0.0.0", "-p", "3000", "-c", "snake", "--token-mode", "tenant_access_token", "-t", "wiki.v2.space.list,wiki.v2.spaceNode.list,wiki.v2.space.getNode,docx.v1.document.rawContent", "--config", "/run/secrets/lark-mcp-config"]`
  写在 Dockerfile CMD（git 可审计，改动即重建）。OMA harness 会全量注册远端返回的工具、
  无二阶 `enabled_tools` 过滤（apps/agent/src/harness/tools.ts:1308-1411），因此 `-t` 进程白名单
  与 `--token-mode tenant_access_token` 是**唯一**可靠的写隔离与应用身份边界。
- **server 名**：`feishu-kb`（工具名如 `mcp__feishu-kb__wiki_v2_space_list`）。
  不用 `feishu`——与内置 in-process 工具 `mcp__feishu__im_message_send/im_chat_read`
  （apps/main-node/src/lib/feishu-agent-tools.ts）仅名字相像、机制不同，撞名会造成提示词混淆。
- **不复用** `FeishuApiClient`（tenant-only、IM-only）；sidecar 用官方 lark-mcp。
- **官方托管 mcp.feishu.cn 维持 No-go**：console 注册表禁用中（apps/console/src/data/mcp-registry.ts:51-58，
  卡 partner allowlist + HTTPS redirect URI），且托管面无法 `-t`。

### 工具面身份支持（源码与 0.5.1 运行核实）

| 上游 API / CLI 过滤名 | 实际暴露工具名 (snake) | OMA 工具全名 | accessTokens | 用途 |
|------|-------------|--------------|-------------|------|
| `wiki.v2.space.list` | `wiki_v2_space_list` | `mcp__feishu-kb__wiki_v2_space_list` | `['tenant','user']` | 列出应用可访问的知识空间 |
| `wiki.v2.spaceNode.list` | `wiki_v2_spaceNode_list` | `mcp__feishu-kb__wiki_v2_spaceNode_list` | `['tenant','user']` | 列空间节点树 |
| `wiki.v2.space.getNode` | `wiki_v2_space_getNode` | `mcp__feishu-kb__wiki_v2_space_getNode` | `['tenant','user']` | token→obj 解析（/wiki/{token} 链接）|
| `docx.v1.document.rawContent` | `docx_v1_document_rawContent` | `mcp__feishu-kb__docx_v1_document_rawContent` | `['tenant','user']` | 读 docx 正文 |

## 3. 凭证分层（P0）

```
App ID / App Secret → ./secrets/lark-mcp-config.json（docker secret 挂载，仅 sidecar 进程可读；
                       示例见 docker/lark-mcp/config.example.json；secrets/ 目录 gitignore）
tenant_access_token → lark-mcp SDK 运行时获取/缓存/过期重取，不持久化
用户 access/refresh  → P0 不使用
OMA Vault            → P0 不使用（多租户演进见 §6）
agent 侧             → mcp_servers 只存 http://oma-lark-mcp:3000/mcp，零凭证
```

不走 `-a/-s` 裸参（会漏在容器 `ps` 输出里），统一 `--config /run/secrets/lark-mcp-config`。

**优先级即安全属性**（lark-mcp src/cli.ts 源码核实）：选项合并顺序为
`CLI 参数 > --config 文件 > 环境变量 > 默认值`，且 config 解析无 schema 校验（裸 `JSON.parse`）。
因此即使 secret 配置文件被塞入 `tools` 字段试图放宽白名单，也压不过 Dockerfile CMD 里的 `-t`——
白名单的唯一改动入口是改 Dockerfile（git 审计 + 重建镜像）。config 文件里的 `$comment` 等未知字段
会被静默忽略。

## 4. 飞书侧配置（操作员）

1. 独立只读 App（沿用原方案：专用 App，不与 IM bot 混用）。
2. 权限只开两个：`wiki:wiki:readonly`、`docx:document:readonly`。
3. **把 App 显式加入目标知识空间**（知识空间设置 → 添加成员，选应用）。
   scope 不绕过飞书 ACL：不在空间里 = 读不到（这正是验收③的负向用例）。
4. `cp docker/lark-mcp/config.example.json secrets/lark-mcp-config.json` 并填入凭证。

## 5. 边界（必须遵守）

1. P0 = 指定团队知识空间连接器；非用户个人知识库连接器，非搜索连接器。
2. 仅 Node self-host/Compose。CF runtime 够不着 compose 内网地址，**不宣称双运行时支持**。
3. App 必须被显式加入空间；ACL 不被 scope 绕过。
4. 当前限制说明：Wiki 底层对象仅支持 `docx`；Sheet/Base/Slides 节点直接透传上游原始响应/错误（sidecar 与 harness 暂未做格式拦截转换）。
5. 镜像锁版本（当前 0.5.1，Beta）；**禁止**运行时无锁 `npx -y ...@latest`。
6. 不发布 host port（compose 内网 only）；跨主机部署必须先补 ingress authentication（当前债）。

## 6. 后续（非 P0）

| 项 | 状态 | 说明 |
|----|------|------|
| per-user 身份（读个人知识库/搜索） | **阻塞于身份模型** | 三选项均不 Ready：Docker 用户 OAuth 不支持（§1#6）；官方托管卡 allowlist；自研 refresh 是高风险核心改动。不勉强选型。 |
| 搜索工具（`search:docs:read` + 两个 user-only 工具） | 阻塞 | 依赖身份模型解锁，P2+ |
| vault 化 | 债 | 多租户时迁 `mcp_oauth` 凭证（refresh_token/token_endpoint 字段现成，apps/main/src/routes/oauth.ts:703-779），并实现 node-mcp-fetch.ts 预留的 pickCredentialByHost 注入缝 |
| 跨主机 ingress auth | 债 | lark-mcp streamable 无内建 ingress 鉴权（`--oauth` 是 Beta 的 MCP Auth Server，面向用户身份） |

## 7. 验收（四条，全过才算 P0 Done）

1. `tools/list` **精确等于** 4 个白名单工具（不多不少）。
2. 对任何已知写工具名（如 `docx.builtin.import`、`drive.v1.permissionMember.create`）发起调用 →
   返回 method/tool not found（进程层未注册）。
3. 能读取应用已加入空间里的 docx 正文；对未加入空间的节点/文档读取被拒（ACL 生效）。
4. sidecar 重启、tenant_access_token 过期后，**无人工干预**自动恢复读取（SDK 重新取 token）。

### 冒烟 SOP

```bash
# 0) 前置：飞书侧 §4 配好；secrets/lark-mcp-config.json 就位
#    （注意：镜像构建未在本地验证过——开发机 docker daemon 常不在跑；
#    首次 up --build 在部署机上即构建验证，锁版本 0.5.1 + bin 路径若有问题会在此暴露）
# 1) 起服务
docker compose -f docker-compose.yml up -d --build oma-lark-mcp
# 2) 验收① tools/list 恰 4 工具（容器内执行，无 host port）
docker compose exec oma-server node -e '
 const r = await fetch("http://oma-lark-mcp:3000/mcp", {method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"smoke",version:"0"}}})});
 const s = await fetch("http://oma-lark-mcp:3000/mcp", {method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",mcp_session_id:""},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})});
 console.log((await s.text()).slice(0,2000));'
# 3) 验收② 负向：对写工具名发 tools/call，断言 not found
# 4) 挂到 agent（见 scripts/attach-lark-mcp.ts），会话内实际调
#    mcp__feishu-kb__wiki_v2_space_list 走通（验收③）
# 5) docker compose restart oma-lark-mcp → 再调一次（验收④）
```

> 注：streamable 会话头细节以 @ai-sdk/mcp 实际握手为准；冒烟以 agent 会话内真实调用
> 为最终判据，手工 JSON-RPC 仅作旁证。

## 8. 挂载方式

`scripts/attach-lark-mcp.ts`（仿 attach-cmdb-mcp.ts）：
- server 名 `feishu-kb`，URL 默认 `http://oma-lark-mcp:3000/mcp`；
- `--all` 或 `AGENTS=name1,name2` 选目标；
- PUT body **必须带 `version`**（F6 契约：缺 version → 428；stale → 409 带最新 etag，重读重试一次）。
  （存量 attach-cmdb-mcp.ts 未带 version，在 F6 落地后已不合规，另行修复，不在本切片。）
