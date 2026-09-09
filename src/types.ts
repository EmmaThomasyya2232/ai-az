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
  /** Azure 节点池 JSON 字符串 (Phase 1, Phase 2 迁移 D1) */
  AZURE_NODES: string;
  /** Azure 数据面 API 版本, 默认 2024-10-21 */
  AZURE_API_VERSION?: string;
  /** 上游请求超时毫秒, 默认 120000 */
  REQUEST_TIMEOUT_MS?: string;
}
