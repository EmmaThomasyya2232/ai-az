# Azure AI Manager

部署于 Cloudflare Workers 的 Azure AI 综合控制面板（零 KV / 零 DO / 零 R2，唯一持久层为 D1）。

> 规划文档见上级目录 `计划文档.md`。当前为**阶段一：网关核心 MVP**。

## 阶段一已实现

- ✅ Hono 单 Worker 工程（前后端一体，Static Assets 托管面板）
- ✅ OpenAI 兼容网关：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/images/edits`、`GET /v1/models`
- ✅ OpenAI→Azure 协议转换（`Authorization: Bearer sk-az-*` → `api-key`，剥离 `model` 字段，改写为 `/openai/deployments/{deployment}/...`）
- ✅ SSE 流式零拷贝透传（`TransformStream`，自动注入 `stream_options.include_usage`）
- ✅ DirectKey 多节点轮询 + 加权调度 + 429/5xx 自动故障转移（最多 3 跳）
- ✅ 网关 Key 鉴权（SHA-256 摘要比较）

## 快速开始

```bash
cd azure-ai-manager
npm install
copy .dev.vars.example .dev.vars   # 编辑 .dev.vars, 填入你的 Azure 节点信息
npm run dev                        # 本地开发 http://localhost:8787
```

### 配置说明

| 变量 | 说明 |
| --- | --- |
| `GATEWAY_KEYS` | 对外发放的网关 Key，逗号分隔多个，如 `sk-az-aaa,sk-az-bbb` |
| `AZURE_NODES` | Azure 节点池 JSON 数组（DirectKey 模式），见 `.dev.vars.example` |
| `AZURE_API_VERSION` | Azure 数据面版本，默认 `2024-10-21` |
| `REQUEST_TIMEOUT_MS` | 上游请求超时，默认 120000 |

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

### 部署

```bash
npm run typecheck        # 类型检查
npm run dry-run          # 本地构建验证
npx wrangler secret put GATEWAY_KEYS
npx wrangler secret put AZURE_NODES
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

- **阶段二**：D1 持久层（凭据 AES-GCM 加密）、三层令牌缓存、ARM 管理面 API 全矩阵
- **阶段三**：Cron 巡检、自动养号、熔断状态机、Webhook 通知
- **阶段四**：React SPA 可视化管理面板
- **阶段五**：熔断优化、用量报表、一键部署交付

> 阶段一节点池来自 `AZURE_NODES` 环境变量（明文 Secret）；阶段二迁移 D1 后将改为加密存储并支持面板在线管理。
