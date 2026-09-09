export interface AzureNode {
  /** 节点别名, 用于日志与错误提示 */
  name: string;
  /** 实例数据面 Endpoint, 如 https://xxx.openai.azure.com */
  endpoint: string;
  /** 实例 API Key */
  apiKey: string;
  /** 对外模型别名 -> Azure 部署名 */
  deployments: Record<string, string>;
  /** 调度权重 1~10, 默认 1 */
  weight?: number;
  /** 是否启用, 默认 true */
  enabled?: boolean;
}

export interface Env {
  /** Workers Static Assets 绑定 (管理面板占位页) */
  ASSETS: Fetcher;
  /** 对外发放的网关 Key, 逗号分隔 */
  GATEWAY_KEYS: string;
  /** 管理面板/Admin API 鉴权 Token (Bearer), 不配置则 /admin/nodes* 返回 500 */
  ADMIN_TOKEN?: string;
  /** 凭据静态加密主密钥, 32 字节 (64 位 hex 或 base64) */
  CREDENTIAL_ENCRYPTION_KEY?: string;
  /** D1 绑定 (Phase 2 节点池持久层), 未绑定时回落 AZURE_NODES 环境变量 */
  DB?: D1Database;
  /** Azure 节点池 JSON 字符串 (Phase 1 回落配置, D1 无数据时使用) */
  AZURE_NODES: string;
  /** Azure 数据面 API 版本, 默认 2024-10-21 */
  AZURE_API_VERSION?: string;
  /** 上游请求超时毫秒, 默认 120000 */
  REQUEST_TIMEOUT_MS?: string;
  /** Entra ID 登录端点, 默认 https://login.microsoftonline.com (本地测试可指向 mock) */
  AAD_AUTHORITY?: string;
  /** ARM 管理面基础 URL, 默认 https://management.azure.com (本地测试可指向 mock) */
  ARM_BASE_URL?: string;
  /** ARM API 默认版本, 默认 2023-05-01 */
  ARM_API_VERSION?: string;
  /** 阶段三: 用量日志开关, 'off' 关闭 (默认开启, 依赖 DB 绑定) */
  USAGE_LOGGING?: string;
  /** 阶段三: 请求日志保留天数, 默认 7 (低频 opportunistic 滚动清理) */
  LOG_RETENTION_DAYS?: string;
  /** 阶段三: 全局默认限流 (次/分钟), 对未单独配置 rateLimitPerMin 的 Key 与环境变量 Key 生效; 缺省不限 */
  DEFAULT_RATE_LIMIT_PER_MIN?: string;
}

