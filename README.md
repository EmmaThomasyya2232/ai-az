# Azure AI Manager

部署于 Cloudflare Workers 的 Azure AI 综合控制面板（零 KV / 零 DO / 零 R2，唯一持久层为 D1）。

> 规划文档见上级目录 `计划文档.md`。当前为**阶段二：D1 持久层**（阶段一网关 MVP 已完成）。

## 阶段一已实现

- ✅ Hono 单 Worker 工程（前后端一体，Static Assets 托管面板）
- ✅ OpenAI 兼容网关：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/images/edits`、`GET /v1/models`
- ✅ OpenAI→Azure 协议转换（`Authorization: Bearer sk-az-*` → `api-key`，剥离 `model` 字段，改写为 `/openai/deployments/{deployment}/...`）
- ✅ SSE 流式零拷贝透传（`TransformStream`，自动注入 `stream_options.include_usage`）
- ✅ DirectKey 多节点轮询 + 加权调度 + 429/5xx 自动故障转移（最多 3 跳）
- ✅ 网关 Key 鉴权（SHA-256 摘要比较）

## 阶段二已实现

- ✅ D1 持久层：节点池 `nodes` 表（迁移脚本 `migrations/0001_init.sql`）
- ✅ 凭据静态加密：Azure API Key 以 AES-GCM（WebCrypto）加密落库，密文格式 `v1:<iv_b64>:<ciphertext_b64>`，主密钥为 Secret `CREDENTIAL_ENCRYPTION_KEY`（32 字节）
- ✅ 节点池 CRUD 管理 API：`/admin/nodes`（Bearer `ADMIN_TOKEN` 鉴权，SHA-256 摘要比较，响应中凭据脱敏为 `***末4位`）
- ✅ 迁移兼容：`loadNodes()` 优先读 D1；D1 未绑定 / 表为空时自动回落 `AZURE_NODES` 环境变量（阶段一行为不变）
- ✅ 三层令牌缓存（`migrations/0002_token_cache.sql` + `src/core/token-cache.ts`）：
  - **L1** isolate 内存（worker 生命周期内）→ **L2** D1 `token_cache`（令牌加密落库，跨重启共享）→ **L3** Entra ID `client_credentials` 上游刷新（写穿透 L1+L2）
  - 统一提前 5 分钟刷新（`REFRESH_SKEW`），支持 `?refresh=true` 强制上游刷新与显式失效（L1+L2）
  - 服务主体管理：`/admin/sps` CRUD，`client_secret` AES-GCM 加密存储；删除 SP 时级联失效其全部令牌缓存
  - 令牌请求失败返回 `502 upstream_token_error`；`AAD_AUTHORITY` 可自定义登录端点（本地测试可指向 `mock-aad.js`）
- ✅ ARM 管理面全矩阵（`src/core/arm.ts` + `/admin/arm/*`）：SP 取令牌 → ARM REST（7 个便捷端点 + 通用透传）

## 阶段三已实现（用量统计与配额限流）

- ✅ D1 化网关 Key（`migrations/0003_usage.sql` + `src/core/gateway-keys.ts`）：
  - `gateway_keys` 表只存 **SHA-256 摘要**，明文 `sk-az-<32hex>` 仅创建响应中出现一次；列表展示 `前8位***末4位`
  - 鉴权解析优先 D1 精确摘要命中，未命中回落 `GATEWAY_KEYS` 环境变量（阶段一 Key 继续可用，不限流不配额）
  - 每 Key 可配置：`rateLimitPerMin`（分钟限流）、`dailyRequestQuota`（日请求数配额）、`dailyTokenQuota`（日 token 配额，prompt+completion）；`null` 为不限
- ✅ 限流/配额卡点（上游调用前）：
  - 分钟窗口计数原子 `INSERT ... ON CONFLICT ... RETURNING count`，超限返回 **429** + `Retry-After`
  - 日配额预读 `usage_daily` 当日累计，耗尽返回 **429 `quota_exceeded`**；禁用 Key 返回 **403 `key_disabled`**
  - `DEFAULT_RATE_LIMIT_PER_MIN` 可为环境变量 Key 与未单独限流的 Key 提供全局兜底
- ✅ 用量日志（`request_logs` + `usage_daily` 聚合，`src/core/usage.ts`）：
  - 响应经 `body.tee()` 一分为二：客户端照常零拷贝透传，日志分支在 `waitUntil` 中异步消费，**不增加响应延迟**
  - 非流式解析 JSON `usage`；SSE 流式提取末帧 `usage`（阶段一已自动注入 `stream_options.include_usage`）
  - 记录：key/节点/部署/路径/状态/延迟/流式标记/token 数/错误；`LOG_RETENTION_DAYS`（默认 7 天）低频滚动清理；全部上游失败也记 502 日志
  - DB 未绑定或 `USAGE_LOGGING=off` 时整体降级直通（阶段一行为）
- ✅ 管理 API：
  - `POST/GET /admin/keys`、`PATCH/DELETE /admin/keys/:id`（发放/列表/改限额与启停/吊销）
  - `GET /admin/usage?days=7&key=<id>`（总览 + 按日 + 按 Key + 按部署聚合）
  - `GET /admin/usage/logs?limit=50&key=<id>`、`DELETE /admin/usage/logs?days=7`（日志查询/清理）


## 快速开始

```bash
npm install
copy .dev.vars.example .dev.vars   # 编辑 .dev.vars, 填入你的 Azure 节点信息

# 阶段二: 初始化本地 D1 (wrangler dev 会自动使用 .wrangler/state 下的本地库)
npx wrangler d1 migrations apply azure-ai-manager --local

npm run dev                        # 本地开发 http://localhost:8787
```

### 配置说明

| 变量 | 说明 |
| --- | --- |
| `GATEWAY_KEYS` | 对外发放的网关 Key，逗号分隔多个，如 `sk-az-aaa,sk-az-bbb` |
| `ADMIN_TOKEN` | 阶段二管理 API 鉴权 Token（Bearer），用于 `/admin/nodes*` |
| `CREDENTIAL_ENCRYPTION_KEY` | 阶段二凭据加密主密钥，32 字节（`openssl rand -hex 32`） |
| `AAD_AUTHORITY` | 阶段二 Entra ID 登录端点，默认 `https://login.microsoftonline.com`；本地测试可指向 `http://localhost:9998`（`mock-aad.js`） |
| `DB` (wrangler 绑定) | 阶段二 D1 绑定，未绑定时节点池回落 `AZURE_NODES` |
| `AZURE_NODES` | Azure 节点池 JSON 数组（DirectKey 模式），见 `.dev.vars.example`；D1 有数据时优先使用 D1 |
| `AZURE_API_VERSION` | Azure 数据面版本，默认 `2024-10-21` |
| `REQUEST_TIMEOUT_MS` | 上游请求超时，默认 120000 |
| `USAGE_LOGGING` | 阶段三用量日志开关，设为 `off` 关闭；默认开启（依赖 DB 绑定） |
| `LOG_RETENTION_DAYS` | 阶段三请求日志保留天数，默认 7 |
| `DEFAULT_RATE_LIMIT_PER_MIN` | 阶段三全局默认限流（次/分钟），对未单独限流的 Key（含环境变量 Key）生效；缺省不限 |

节点池示例：

```json
[
  {
    "name": "node-1",
    "endpoint": "https://YOUR-RESOURCE.openai.azure.com",
    "apiKey": "YOUR-AZURE-KEY",
    "deployments": { "gpt-4o": "gpt-4o", "text-embedding-3-small": "text-embedding-3-small" },
    "weight": 2
  },
  {
    "name": "node-2",
    "endpoint": "https://YOUR-RESOURCE2.openai.azure.com",
    "apiKey": "YOUR-AZURE-KEY2",
    "deployments": { "gpt-4o": "gpt4o-deploy" }
  }
]
```

客户端只需把 `baseURL` 指向本服务，`model` 填别名（如 `gpt-4o`）即可，多节点自动聚合与切换。

### 节点池管理 API（阶段二）

```bash
# 列出节点 (凭据脱敏显示)
curl http://localhost:8787/admin/nodes -H "Authorization: Bearer <ADMIN_TOKEN>"

# 创建节点
curl -X POST http://localhost:8787/admin/nodes \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"name":"node-1","endpoint":"https://YOUR-RESOURCE.openai.azure.com","apiKey":"YOUR-AZURE-KEY","deployments":{"gpt-4o":"gpt4o-deploy"},"weight":2}'

# 部分更新 (省略 apiKey 表示保留原凭据)
curl -X PUT http://localhost:8787/admin/nodes/node-1 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"enabled":false}'

# 删除节点
curl -X DELETE http://localhost:8787/admin/nodes/node-1 -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### 服务主体与令牌缓存 API（阶段二）

```bash
# 登记服务主体 (client_secret 加密落库)
curl -X POST http://localhost:8787/admin/sps \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"id":"sp-1","tenantId":"<TENANT_ID>","clientId":"<CLIENT_ID>","clientSecret":"<SECRET>"}'

# 获取访问令牌 (三层缓存: L1 内存 -> L2 D1 -> L3 Entra ID; 默认 scope 为 ARM 管理面)
curl -X POST http://localhost:8787/admin/sps/sp-1/token \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{}'
# => {"source":"upstream|d1|memory", "expiresAt":"...", "tokenMasked":"***xxxx"}

# 强制上游刷新
curl -X POST http://localhost:8787/admin/sps/sp-1/token \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"refresh":true}'

# 失效缓存 (L1+L2); body 省略则失效该 SP 全部 scope
curl -X DELETE http://localhost:8787/admin/sps/sp-1/token \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{}'
```

### ARM 管理面 API（阶段二）

基于三层令牌缓存（scope 自动派生自 `ARM_BASE_URL`，默认 `https://management.azure.com/.default`），全程免手动管理令牌：

```bash
AT="Authorization: Bearer <ADMIN_TOKEN>"; B=http://localhost:8787; SP=sp-1

# 便捷端点 (面板常用矩阵)
curl "$B/admin/arm/$SP/subscriptions" -H "$AT"                                   # 订阅列表
curl "$B/admin/arm/$SP/subscriptions/<SUB>/resourcegroups" -H "$AT"              # 资源组
curl "$B/admin/arm/$SP/subscriptions/<SUB>/accounts" -H "$AT"                    # OpenAI/Cognitive 账户 (订阅级)
curl "$B/admin/arm/$SP/subscriptions/<SUB>/resourceGroups/<RG>/accounts" -H "$AT" # 账户 (资源组级)
curl "$B/admin/arm/$SP/subscriptions/<SUB>/resourceGroups/<RG>/accounts/<ACC>/deployments" -H "$AT"  # 模型部署
curl "$B/admin/arm/$SP/subscriptions/<SUB>/locations/<LOC>/models" -H "$AT"      # 位置可用模型
curl -X POST "$B/admin/arm/$SP/subscriptions/<SUB>/resourceGroups/<RG>/accounts/<ACC>/listKeys" -H "$AT"  # 取密钥(导入节点池)

# 通用透传: 任意 ARM 路径 + 方法, 全矩阵覆盖; api-version 缺省用 ARM_API_VERSION
curl -X PUT "$B/admin/arm/$SP/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.CognitiveServices/accounts/<ACC>?api-version=2024-10-01" \
  -H "$AT" -H "Content-Type: application/json" -d '{"properties":{...}}'
```

### 网关 Key 管理与用量统计 API（阶段三）

```bash
AT="Authorization: Bearer <ADMIN_TOKEN>"; B=http://localhost:8787

# 发放新 Key (明文仅此一次返回; 支持限流/配额, null 为不限)
curl -X POST $B/admin/keys -H "$AT" -H "Content-Type: application/json" \
  -d '{"label":"team-a","rateLimitPerMin":60,"dailyRequestQuota":1000,"dailyTokenQuota":500000}'
# => {"ok":true,"key":{...},"plaintext":"sk-az-xxxx..."}

# 列表 (脱敏为 前8位***末4位) / 改限额与启停 / 吊销
curl $B/admin/keys -H "$AT"
curl -X PATCH $B/admin/keys/<key_id> -H "$AT" -H "Content-Type: application/json" \
  -d '{"enabled":false,"dailyRequestQuota":null}'
curl -X DELETE $B/admin/keys/<key_id> -H "$AT"

# 用量统计 (总览 + 按日 + 按 Key + 按部署; 可 ?key=<id> 过滤)
curl "$B/admin/usage?days=7" -H "$AT"

# 最近请求日志 / 清理 N 天前日志
curl "$B/admin/usage/logs?limit=50" -H "$AT"
curl -X DELETE "$B/admin/usage/logs?days=7" -H "$AT"
```

### 部署

```bash
npm run typecheck        # 类型检查
npm run dry-run          # 本地构建验证

# 阶段二: 创建 D1 并应用迁移 (替换 wrangler.jsonc 中的 database_id)
npx wrangler d1 create azure-ai-manager
npx wrangler d1 migrations apply azure-ai-manager --remote

npx wrangler secret put GATEWAY_KEYS
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler secret put AZURE_NODES      # 回落配置, D1 有数据后可省略
npx wrangler secret put AZURE_API_VERSION
npm run deploy
```

## 验证

```bash
# 健康检查
curl http://localhost:8787/admin/health

# 模型列表
curl http://localhost:8787/v1/models -H "Authorization: Bearer sk-az-local-test-key"

# 对话 (流式)
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-az-local-test-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

## 路线图

- **阶段二**：D1 持久层（✅ 凭据 AES-GCM 加密）、✅ 节点池 CRUD 管理 API、✅ 三层令牌缓存、✅ ARM 管理面 API 全矩阵
- **阶段三**：✅ 用量统计与配额限流（D1 化网关 Key、分钟限流 + 日配额、请求日志与统计 API）
- **阶段四**：React SPA 可视化管理面板（节点池/服务主体/ARM 浏览/Key 与用量看板）
- **阶段五**：Cron 巡检、自动养号、熔断状态机、Webhook 通知、一键部署交付


> 阶段二起节点池优先存 D1（凭据 AES-GCM 加密、面板在线管理）；D1 未绑定或无数据时回落 `AZURE_NODES` 环境变量（明文 Secret）。
