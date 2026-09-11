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
  /** 阶段五: 节点熔断器开关, 'off' 关闭 (默认开启, 依赖 DB 绑定) */
  BREAKER_ENABLED?: string;
  /** 阶段五: 连续失败多少次后熔断, 默认 3 */
  BREAKER_FAILURE_THRESHOLD?: string;
  /** 阶段五: 熔断冷却秒数, 到期后半开探测, 默认 120 */
  BREAKER_COOLDOWN_SEC?: string;
  /** 阶段五: Webhook 告警 URL (未配置则不告警) */
  ALERT_WEBHOOK_URL?: string;
  /** 阶段五: Webhook 载荷格式 json|slack|discord|feishu, 默认 json */
  ALERT_WEBHOOK_FORMAT?: string;
  /** 阶段五: 告警开关, 'off' 关闭 */
  ALERTS_ENABLED?: string;
  /** 阶段五: Cron 节点探活开关, 'off' 关闭 (默认开) */
  CRON_PROBE_NODES?: string;
  /** 阶段五: Cron 服务主体令牌预热开关 (养号), 'off' 关闭 (默认开) */
  CRON_PREWARM_TOKENS?: string;
  /** 阶段五: Cron 过期日志清理开关, 'off' 关闭 (默认开) */
  CRON_CLEANUP_LOGS?: string;
  /** 阶段五: 令牌预热窗口秒数, 剩余有效期小于该值即提前刷新, 默认 1800 */
  TOKEN_PREWARM_WINDOW_SEC?: string;
  /** 阶段六: 每日养号打卡调度开关, 'off' 关闭 (默认开, 依赖 DB 绑定) */
  CRON_WARMUP?: string;
  /** 阶段六: 养号默认合规区域, 探测失败/无策略时回退, 默认 centralus */
  WARMUP_DEFAULT_REGION?: string;
  /** 阶段六: 养号默认部署模型, 默认 text-embedding-3-small */
  WARMUP_MODEL?: string;
  /** 阶段六: AIServices 账户 SKU, 默认 S0 */
  WARMUP_SKU_NAME?: string;
  /** 阶段六: 打卡消耗 tokens 上限, 默认 32 (极端情况下防失控) */
  WARMUP_MAX_TOKENS?: string;
}

