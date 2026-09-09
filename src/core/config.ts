import type { Env, AzureNode } from "../types";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultApiVersion(env: Env): string {
  return env.AZURE_API_VERSION ?? "2024-10-21";
}

export function requestTimeoutMs(env: Env): number {
  const n = Number(env.REQUEST_TIMEOUT_MS ?? 120000);
  return Number.isFinite(n) && n > 0 ? n : 120000;
}

/**
 * Phase 1: 从 env JSON 字符串解析节点池。
 * Phase 2 将改为从 D1 读取, 本函数是唯一需要替换的入口。
 */
export function loadNodes(env: Env): AzureNode[] {
  if (!env.AZURE_NODES || env.AZURE_NODES.trim() === "") {
    throw new ConfigError("AZURE_NODES is not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.AZURE_NODES);
  } catch {
    throw new ConfigError("AZURE_NODES is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError("AZURE_NODES must be a JSON array");
  }
  const nodes: AzureNode[] = [];
  for (const item of parsed) {
    const n = item as Partial<AzureNode> | null;
    if (
      !n ||
      typeof n.name !== "string" ||
      typeof n.endpoint !== "string" ||
      typeof n.apiKey !== "string" ||
      !n.deployments ||
      typeof n.deployments !== "object"
    ) {
      continue;
    }
    nodes.push({
      name: n.name,
      endpoint: n.endpoint.replace(/\/+$/, ""),
      apiKey: n.apiKey,
      deployments: n.deployments,
      weight: normalizeWeight(n.weight),
      enabled: n.enabled !== false,
    });
  }
  if (nodes.length === 0) {
    throw new ConfigError("AZURE_NODES contains no valid node");
  }
  return nodes;
}

function normalizeWeight(w: unknown): number {
  const n = Math.floor(Number(w ?? 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, n));
}

/** 429 与 5xx 视为瞬态错误, 可故障转移到下一个节点 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
