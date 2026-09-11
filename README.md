# Azure AI Manager

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EmmaThomasyya2232/ai-az)

部署于 Cloudflare Workers 的 Azure AI 综合控制面板（零 KV / 零 DO / 零 R2，唯一持久层为 D1）。

> 规划文档见上级目录 `计划文档.md`。当前已完成：阶段一（网关 MVP）→ 阶段二（D1 持久层）→ 阶段三（用量/配额）→ 阶段四（面板）→ 阶段五（巡检/熔断/告警）→ **阶段六（SP 一键纳管 / 区域白名单探测 / 自动养号打卡 / Tier 与配额看板）**。

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

## 阶段五已实现（巡检 / 熔断 / 告警 / 交付）

- ✅ **节点熔断状态机**（`migrations/0004_breaker.sql` + `src/core/breaker.ts`，D1 持久化、跨 isolate 共享）：
  - 状态机：`closed` --连续失败 ≥ 阈值(默认3)--> `open` --冷却到期(默认120s, 原子抢占)--> `half_open` --成功--> 删行闭合 / --失败--> 重新 `open`
  - 网关调度前过滤熔断节点；全部候选被熔断时返回 **503 `circuit_open`** + `Retry-After`（剩余冷却最小值）
  - 瞬态失败（408/409/429/5xx/网络错误）计数，成功即清零闭合；`BREAKER_ENABLED=off` 或未绑定 DB 时无操作
  - 面板节点列表显示熔断徽标 + 一键复位；`GET /admin/breakers`、`POST /admin/breakers/:name/reset`
- ✅ **Cron 定时巡检**（`wrangler.jsonc triggers: */5 * * * *` + `src/core/patrol.ts` + `scheduled` 导出）：
  - **节点探活**：`GET /openai/models`（零 token 成本）联动熔断自愈（恢复时自动闭合并发通知）
  - **令牌预热（养号）**：剩余有效期 < `TOKEN_PREWARM_WINDOW_SEC`（默认 1800s）的 SP 令牌提前刷新，用户请求不再承担刷新延迟
  - **日志清理**：按 `LOG_RETENTION_DAYS` 滚动删除过期请求日志
  - 手动触发：`POST /admin/patrol`（面板设置页「立即巡检」）/ 本地 `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`
- ✅ **Webhook 告警**（`src/core/notify.ts`）：节点熔断打开/恢复、网关全部节点失败、SP 令牌刷新失败、巡检异常汇总；
  载荷格式 `ALERT_WEBHOOK_FORMAT`: `json`（结构化，默认）/ `slack` / `discord` / `feishu`
- ✅ **一键部署交付**：`.github/workflows/deploy.yml` — push main 自动 typecheck → 远程 D1 迁移 → `wrangler deploy`  （需在仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，并在 `wrangler.jsonc` 填入真实 `database_id`）

## 阶段六已实现（SP 智能纳管 / 区域白名单 / 养号打卡 / Tier 看板）

### 模块 1：服务主体智能纳管与订阅自动发现

- ✅ **一键粘贴 JSON 录入**：面板「🛡️ 服务主体」页新增 `📋 一键粘贴 JSON` 弹窗——直接粘贴 `az ad sp create-for-rbac` 输出的标准 JSON（`appId` / `displayName` / `password` / `tenant`）即完成录入。
- ✅ **OAuth2 验真**：录入时先请求 Entra ID 管理令牌（`client_credentials`，Scope `https://management.azure.com/.default`），凭据无效直接拒绝（401），提前拦截录入手误。
- ✅ **订阅穿透自动发现**：验证通过后自动调用 ARM `GET /subscriptions`，动态拉取该凭据名下的全部订阅并入库存档（`azure_subscriptions` 表，`migrations/0005_subscriptions_warmup.sql`）。
- ✅ **安全入库**：`client_secret` 落库前 AES-GCM 加密（沿用 `CREDENTIAL_ENCRYPTION_KEY`）；API：`POST /admin/sps/import`。

### 模块 2：区域白名单动态探测引擎

- ✅ **策略解析**：探测时调用 `policyAssignments`，经 `policyDefinitions` 解析 `listOfAllowedLocations` 白名单数组。
- ✅ **探针回退**：策略未显式枚举时，在候选区域试探创建最小资源组（成功后立即删除），从 `RequestDisallowedByAzure` 错误文本用正则提取候选区域。
- ✅ **落库与级联**：结果存入 `allowed_regions`（JSON 数组）；「🌱 养号打卡」页一键上架时区域下拉框**仅展示白名单候选区域**。API：`POST /admin/subs/:id/probe`。

### 模块 3：养号打卡与提档引擎（Automated Warmup）

- ✅ **一键安全上架**（`POST /admin/subs/:id/bootstrap`）：最佳合规区域 → 创建/复用资源组 → 创建 `S0` AIServices 实例 → 部署 `text-embedding-3-small`（优先 `GlobalStandard`，失败回退 `Standard`）→ 首发 2-token embedding 微调用（留下非零 Metrics）→ 标记 `warmup_target = 1` / `warmup_status = Active`。
- ✅ **Cron 每日打卡**（`wrangler.jsonc` crons 新增 `0 4 * * *`，UTC 04:00 ≈ 北京时间 12:00）：遍历 `Active` 订阅向已部署模型发送微量请求（默认 2 token），执行耗时 / 消耗 token / 状态码写入 `warmup_logs`；本地测试 `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+4+*+*+*"`。
- ✅ **提档感知与推送**：调用 CognitiveServices `QuotaTiers` API 检测 `currentTierName`；由 `Free Tier` 变为更高档时——数据库标记 `Upgraded`（停止打卡以节省资源）、经 Webhook（`json`/`slack`/`discord`/`feishu`，URL 可用 `system_configs.alert_webhook_url` 动态覆盖）推送「🎉 订阅提档成功」通知。
- ✅ **系统配置表**（`system_configs`，API `GET /admin/config` / `PUT|DELETE /admin/config/:key`）：`warmup_enabled`、`warmup_model`、`warmup_default_region`、`alert_webhook_url` 等可在面板动态调整，优先于环境变量。

### 模块 4：Tier 与配额看板（Radar Dashboard）

- ✅ 侧边栏新增 **「🌱 养号打卡」** 与 **「📊 配额与 Tier」** 视图：
  - **订阅资产画像**：订阅名/ID、服务主体、当前 Tier、合规区域白名单、打卡状态（`Pending/Active/Upgraded/Disabled`）、上架标记；行内操作：探测区域 / 一键上架 / 查看 Tier / 删除。
  - **Tier 状态卡片**：`currentTierName`、分配时间、`tierUpgradePolicy`、`upgradeUnavailabilityReason`。
  - **配额水位**：CognitiveServices `Usage` API 分区展示 TPM / RPM 等指标当前值 / 限额 / 使用率进度条。
  - **打卡流水表格**：时间、实例、模型、消耗 tokens、状态码、延迟、结果、错误。
- ✅ 面板新增「📋 一键粘贴 JSON」「↻ 同步全部订阅」（`POST /admin/subs/sync/:spId`）按钮。


## 快速开始

```bash
npm install
copy .dev.vars.example .dev.vars   # 编辑 .dev.vars, 填入你的 Azure 节点信息

# 初始化本地 D1 (wrangler dev 会自动使用 .wrangler/state 下的本地库)
npm run db:migrations:local

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
| `BREAKER_ENABLED` / `BREAKER_FAILURE_THRESHOLD` / `BREAKER_COOLDOWN_SEC` | 阶段五熔断器：开关（默认 on）/ 熔断阈值（默认 3）/ 冷却秒数（默认 120） |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_FORMAT` / `ALERTS_ENABLED` | 阶段五 Webhook 告警：地址 / 载荷格式 json\|slack\|discord\|feishu / 开关 |
| `CRON_PROBE_NODES` / `CRON_PREWARM_TOKENS` / `CRON_CLEANUP_LOGS` | 阶段五 Cron 巡检任务开关（默认全开） |
| `TOKEN_PREWARM_WINDOW_SEC` | 阶段五令牌预热窗口（秒），剩余有效期小于该值即提前刷新，默认 1800 |
| `CRON_WARMUP` | 阶段六每日养号打卡开关，设为 `off` 关闭；默认开启（依赖 DB 绑定） |
| `WARMUP_DEFAULT_REGION` | 阶段六养号默认合规区域，探测失败/无策略时回退，默认 `centralus` |
| `WARMUP_MODEL` | 阶段六打卡模型，默认 `text-embedding-3-small` |
| `WARMUP_SKU_NAME` | 阶段六 AIServices 账户 SKU，默认 `S0` |
| `WARMUP_MAX_TOKENS` | 阶段六单次打卡 tokens 上限，默认 32 |

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

### 可视化管理面板（阶段四）

打开站点根路径即可使用（`/`），纯静态 SPA（原生 JS，零构建依赖），由 Worker 的 `ASSETS` 托管：

- **首次使用**：弹窗输入 `ADMIN_TOKEN`（仅存浏览器 localStorage，随时可清除/更换）
- **📊 概览**：请求 / Tokens / 错误率 / 平均延迟卡片，每日趋势柱状图，按 Key 与按部署分组统计
- **🔑 网关密钥**：发放（明文仅显示一次，一键复制）、编辑限额、启停、吊销
- **📜 用量日志**：最近请求明细（Key/节点/部署/状态/延迟/token/错误），按 Key 过滤，手动清理旧日志
- **🖥️ 节点池**：节点 CRUD，部署映射（OpenAI 模型名→Azure 部署名）JSON 编辑
- **🛡️ 服务主体**：Entra ID SP CRUD、令牌刷新/失效（L1+L2 缓存）、**一键粘贴 `az ad sp create-for-rbac` JSON 并自动发现订阅**
- **☁️ Azure 资源浏览器**：选 SP → 订阅 → 资源组 → OpenAI/Cognitive 账户 → 部署列表，**一键 `listKeys` 导入为网关节点**（凭据自动加密落库）
- **🌱 养号打卡**：订阅资产画像（Tier / 区域白名单 / 打卡状态），一键探测合规区域、🪴 一键上架（AIServices + Embedding 部署）、立即打卡、打卡流水
- **📊 配额与 Tier**：订阅 Tier 状态卡片（提档策略 / 不可升级原因）、分区配额水位（TPM / RPM 使用率）
- **⚙️ 设置**：服务健康、ARM 配置元信息、网关接入示例

### 部署

三种方式任选其一，从上到下越来越省事：

#### 方式一：Deploy to Cloudflare 按钮（零命令行，推荐新用户）

点击 README 顶部的 **Deploy to Cloudflare** 按钮（或访问 `https://deploy.workers.cloudflare.com/?url=<仓库地址>`）：

1. Cloudflare 自动 Fork 仓库到你的账号，并**自动创建 D1 数据库**（读取 `wrangler.jsonc`，`database_id` 占位符自动替换，无需手动填写）
2. 在配置页按提示填写 Secrets（提示文案来自 `.dev.vars.example` 与 `package.json` 的 `cloudflare.bindings` 说明）：
   - `ADMIN_TOKEN`（**必填**，自定义一个足够长的随机字符串，如 `openssl rand -hex 16`）
   - `CREDENTIAL_ENCRYPTION_KEY`（**必填**，`openssl rand -hex 32` 生成，用于凭据加密，注意保存）
   - `GATEWAY_KEYS` / `AZURE_NODES` 可留空，稍后在面板中在线配置
3. Cloudflare 使用 `package.json` 的 `deploy` 脚本构建部署（**自动先应用 D1 迁移**），完成后即可打开面板

> 注意：按钮部署要求仓库为 Public，且 Cloudflare 会把仓库 Fork 到你的账号下继续开发。

#### 方式二：CLI 一键部署（一条命令，适合自己的机器）

```bash
npm install
npx wrangler login      # 浏览器授权一次（CI 环境可用 CLOUDFLARE_API_TOKEN 环境变量）
npm run setup
```

`npm run setup` 会自动完成：检查登录 → 查找/创建 D1 → 回填 `database_id` 到 `wrangler.jsonc` → 应用远程迁移 → 自动生成并写入缺失的 Secrets（`ADMIN_TOKEN` / `CREDENTIAL_ENCRYPTION_KEY` / `GATEWAY_KEYS`，随机生成、终端仅显示一次）→ 部署 → 打印访问地址。

支持参数覆盖自动生成的值：

```bash
npm run setup -- --admin-token=你的管理令牌 --gateway-keys=sk-az-a,sk-az-b --cred-key=<64位hex>
npm run setup -- --azure-nodes='[{"name":"node-1","endpoint":"https://xxx.openai.azure.com","apiKey":"KEY","deployments":{"gpt-4o":"gpt-4o"}}]'
npm run setup -- --skip-deploy   # 只准备资源与 Secrets, 不部署
```

重复执行安全（幂等）：已有 D1 复用、已配置的 Secrets 跳过、迁移只应用未执行的。

#### 方式三：手动分步（排查问题时使用）

```bash
npm run typecheck        # 类型检查
npm run dry-run          # 本地构建验证

# 创建 D1 并应用迁移 (把输出的 database_id 填入 wrangler.jsonc)
npx wrangler d1 create azure-ai-manager
npm run db:migrations:apply   # 等价于 npx wrangler d1 migrations apply DB --remote (DB 为绑定名)

npx wrangler secret put GATEWAY_KEYS
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler secret put AZURE_NODES      # 回落配置, D1 有数据后可省略
npx wrangler secret put AZURE_API_VERSION
npm run deploy                # 等价于: 迁移(幂等) + wrangler deploy
```

#### 持续部署

`.github/workflows/deploy.yml`：push main 自动 typecheck → 远程 D1 迁移（按绑定名 `DB`）→ `wrangler deploy`（需在仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）。

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
- **阶段四**：✅ 可视化管理面板（概览看板/Key/日志/节点池/服务主体/ARM 浏览器一键导入节点，原生 JS 零构建）
- **阶段五**：✅ Cron 定时巡检（探活/令牌预热养号/日志清理）、✅ 节点熔断状态机、✅ Webhook 告警、✅ GitHub Actions 一键部署交付
- **阶段六**：✅ SP 一键粘贴 JSON 纳管 + OAuth2 验真 + 订阅自动发现、✅ 区域白名单动态探测（策略解析 + 探针回退）、✅ 自动养号打卡（Cron 每日微量打卡 + 一键上架 + 提档检测通知）、✅ Tier 与配额看板


> 阶段二起节点池优先存 D1（凭据 AES-GCM 加密、面板在线管理）；D1 未绑定或无数据时回落 `AZURE_NODES` 环境变量（明文 Secret）。
