import type { Env } from "../types";
import type { SpRecord } from "./sp";
import { getAccessToken } from "./token-cache";

/**
 * Azure Resource Manager 管理面调用核心 (阶段二):
 * 使用三层令牌缓存 (L1 内存 -> L2 D1 -> L3 Entra ID) 携带 Bearer 令牌
 * 请求任意 ARM 路径, 供 /admin/arm/* 管理矩阵使用。
 */

export class ArmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArmError";
  }
}

export interface ArmCallResult {
  status: number;
  body: unknown;
  isJson: boolean;
}

const ARM_TIMEOUT_MS = 30_000;

export function defaultArmBase(env: Env): string {
  return (env.ARM_BASE_URL ?? "https://management.azure.com").replace(/\/+$/, "");
}

/** ARM 令牌 scope 由 base URL 派生: https://management.azure.com/.default */
export function armScope(env: Env): string {
  return `${new URL(defaultArmBase(env)).origin}/.default`;
}

export function defaultArmApiVersion(env: Env): string {
  return env.ARM_API_VERSION ?? "2023-05-01";
}

/**
 * 调用 ARM 管理面。
 * @param armPath 以 "/" 开头的 ARM 路径, 如 /subscriptions
 * @param opts.apiVersion 缺省用 env.ARM_API_VERSION (默认 2023-05-01)
 * @param opts.body 原始请求体 (已缓冲的 ArrayBuffer), GET/HEAD 应省略
 */
export async function armRequest(
  env: Env,
  sp: SpRecord,
  method: string,
  armPath: string,
  opts: {
    apiVersion?: string;
    body?: BodyInit;
    contentType?: string | null;
    query?: Record<string, string>;
  } = {}
): Promise<ArmCallResult> {
  if (!armPath.startsWith("/")) {
    throw new ArmError("ARM path must start with '/'");
  }
  const url = new URL(defaultArmBase(env) + armPath);
  url.searchParams.set("api-version", opts.apiVersion ?? defaultArmApiVersion(env));
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const token = await getAccessToken(env, {
    tenantId: sp.tenantId,
    clientId: sp.clientId,
    clientSecret: sp.clientSecret,
    scope: armScope(env),
  });

  const headers = new Headers({ authorization: `Bearer ${token.token}` });
  if (opts.body !== undefined) {
    headers.set("content-type", opts.contentType ?? "application/json");
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: opts.body,
      signal: AbortSignal.timeout(ARM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ArmError(
      `ARM request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const text = await resp.text();
  let body: unknown = text;
  let isJson = false;
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      body = JSON.parse(text);
      isJson = true;
    } catch {
      /* keep raw text */
    }
  }
  return { status: resp.status, body, isJson };
}
