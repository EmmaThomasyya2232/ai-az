import type { Env } from "../types";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * 三层令牌缓存 (Entra ID access token):
 *   L1 isolate 内存 (worker 生命周期内, 明文, 不出进程)
 *   L2 D1 token_cache (令牌 AES-GCM 加密落库, 跨 isolate/重启共享)
 *   L3 Entra ID client_credentials 上游刷新 (写穿透 L2 + L1)
 * 所有层统一使用 REFRESH_SKEW 提前刷新, 避免边界过期。
 */

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export type TokenSource = "memory" | "d1" | "upstream";

export interface TokenResult {
  token: string;
  /** Unix 毫秒 */
  expiresAt: number;
  source: TokenSource;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

interface TokenCacheRow {
  token_enc: string;
  expires_at: number;
}

/** L1: isolate 内存缓存 */
const memory = new Map<string, CacheEntry>();

/** 提前 5 分钟刷新, 避免使用临界过期的令牌 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function buildCacheKey(tenantId: string, clientId: string, scope: string): string {
  return `aad:${tenantId}:${clientId}:${scope}`;
}

export function defaultAuthority(env: Env): string {
  return (env.AAD_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
}

/**
 * 获取 Entra ID 访问令牌: L1 -> L2 -> L3。
 * refresh=true 时跳过 L1/L2, 强制上游刷新。
 */
export async function getAccessToken(
  env: Env,
  opts: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    refresh?: boolean;
  }
): Promise<TokenResult> {
  const key = buildCacheKey(opts.tenantId, opts.clientId, opts.scope);
  const now = Date.now();

  if (!opts.refresh) {
    // L1: isolate 内存
    const m = memory.get(key);
    if (m && m.expiresAt - REFRESH_SKEW_MS > now) {
      return { token: m.token, expiresAt: m.expiresAt, source: "memory" };
    }
    // L2: D1
    if (env.DB) {
      try {
        const row = await env.DB
          .prepare("SELECT token_enc, expires_at FROM token_cache WHERE cache_key = ?1")
          .bind(key)
          .first<TokenCacheRow>();
        if (row && row.expires_at * 1000 - REFRESH_SKEW_MS > now) {
          const token = await decryptSecret(env, row.token_enc);
          const expiresAt = row.expires_at * 1000;
          memory.set(key, { token, expiresAt });
          return { token, expiresAt, source: "d1" };
        }
      } catch (e) {
        // L2 失败不阻塞, 继续走 L3
        console.warn("token cache L2 read failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  // L3: Entra ID client_credentials
  const authority = defaultAuthority(env);
  let resp: Response;
  try {
    resp = await fetch(`${authority}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: opts.scope,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new TokenError(
      `Entra ID token request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new TokenError(
      `Entra ID token request returned HTTP ${resp.status}: ${text.slice(0, 200)}`
    );
  }

  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    throw new TokenError("Entra ID token response is not valid JSON");
  }
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new TokenError("Entra ID token response missing access_token/expires_in");
  }

  const token = data.access_token;
  const expiresAt = Date.now() + data.expires_in * 1000;

  // 写穿透 L2 + L1
  if (env.DB) {
    try {
      await env.DB
        .prepare(
          `INSERT INTO token_cache (cache_key, token_enc, expires_at, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(cache_key) DO UPDATE SET
             token_enc = excluded.token_enc,
             expires_at = excluded.expires_at,
             updated_at = datetime('now')`
        )
        .bind(key, await encryptSecret(env, token), Math.floor(expiresAt / 1000))
        .run();
    } catch (e) {
      console.warn("token cache L2 write failed:", e instanceof Error ? e.message : e);
    }
  }
  memory.set(key, { token, expiresAt });

  return { token, expiresAt, source: "upstream" };
}

/** 失效单个 (L1 + L2) 缓存条目 */
export async function evictToken(
  env: Env,
  tenantId: string,
  clientId: string,
  scope: string
): Promise<void> {
  const key = buildCacheKey(tenantId, clientId, scope);
  memory.delete(key);
  if (env.DB) {
    await env.DB.prepare("DELETE FROM token_cache WHERE cache_key = ?1").bind(key).run();
  }
}

/** 删除服务主体时级联失效其全部 scope 的缓存条目 */
export async function evictSpTokens(
  env: Env,
  tenantId: string,
  clientId: string
): Promise<void> {
  const prefix = `aad:${tenantId}:${clientId}:`;
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  if (env.DB) {
    // 注意: 不用 `LIKE ?1` —— workerd 内嵌 SQLite 对 LIKE 绑定参数有 ~50 字符的
    // "pattern too complex" 限制, 前缀串很容易超长; substr 前缀比较语义等价且无限制。
    try {
      await env.DB
        .prepare("DELETE FROM token_cache WHERE substr(cache_key, 1, length(?1)) = ?1")
        .bind(prefix)
        .run();
    } catch (e) {
      // 与 L2 读/写一致: 失效失败仅告警不阻塞 (L1 已清, 残留条目为密文且会自然过期)
      console.warn("token cache L2 evict failed:", e instanceof Error ? e.message : e);
    }
  }
}
