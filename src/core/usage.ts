import type { Env } from "../types";
import type { ResolvedGatewayKey } from "./gateway-keys";

/**
 * 阶段三: 用量统计与配额限流。
 *  - checkRateAndQuota: 上游调用前卡点 (分钟窗口原子计数 + 日配额预读)
 *  - recordUsage: 响应后异步落日志 (waitUntil, body.tee 零阻塞)
 *  - queryUsage / queryUsageLogs / purgeUsageLogs: 管理端统计
 * DB 未绑定或 USAGE_LOGGING=off 时全部降级为直通 (阶段一行为)。
 */

export interface UsageMeta {
  keyId: string;
  keyHash: string;
  node: string;
  deployment: string;
  path: string;
  stream: boolean;
}

export function usageLoggingEnabled(env: Env): boolean {
  return env.USAGE_LOGGING !== "off" && !!env.DB;
}

function intOr(envValue: string | undefined, fallback: number | null): number | null {
  if (envValue === undefined || envValue.trim() === "") return fallback;
  const n = Number(envValue);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function retentionDays(env: Env): number {
  return intOr(env.LOG_RETENTION_DAYS, 7) ?? 7;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(nowSec: number): number {
  const midnight = Math.floor(nowSec / 86400) * 86400 + 86400;
  return Math.max(1, midnight - nowSec);
}

// ---------- 限流与配额 ----------

export type GateDecision =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 429;
      code: string;
      message: string;
      retryAfterSec?: number;
    };

const OK: GateDecision = { ok: true };

function overLimit(
  status: 403 | 429,
  code: string,
  message: string,
  retryAfterSec?: number
): GateDecision {
  return { ok: false, status, code, message, retryAfterSec };
}

interface DailyUsed {
  requests: number;
  tokens: number;
}

async function dailyUsed(env: Env, keyHash: string): Promise<DailyUsed> {
  const row = await env.DB!.prepare(
    `SELECT requests, prompt_tokens + completion_tokens AS tokens
       FROM usage_daily WHERE key_hash = ?1 AND day = ?2`
  )
    .bind(keyHash, utcDay())
    .first<{ requests: number; tokens: number }>();
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * 分钟窗口 + 日配额统一卡点。分钟计数用原子 UPSERT RETURNING,
 * 超限请求同样计入窗口 (持续打满即持续 429, 不需要额外计数)。
 */
async function minuteGate(
  env: Env,
  keyHash: string,
  rpm: number | null,
  dayReqQuota: number | null,
  dayTokQuota: number | null
): Promise<GateDecision> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 60);

  if (rpm !== null) {
    const row = await env.DB!
      .prepare(
        `INSERT INTO rate_limits (key_hash, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key_hash, window_start) DO UPDATE SET count = count + 1
         RETURNING count`
      )
      .bind(keyHash, windowStart)
      .first<{ count: number }>();
    const count = row?.count ?? 1;
    if (count > rpm) {
      return overLimit(
        429,
        "rate_limit_exceeded",
        `Rate limit exceeded: ${rpm} requests per minute for this key`,
        60 - (nowSec % 60)
      );
    }
  }

  if (dayReqQuota !== null || dayTokQuota !== null) {
    const used = await dailyUsed(env, keyHash);
    if (dayReqQuota !== null && used.requests >= dayReqQuota) {
      return overLimit(
        429,
        "quota_exceeded",
        `Daily request quota exhausted: ${used.requests}/${dayReqQuota} requests today`,
        secondsUntilUtcMidnight(nowSec)
      );
    }
    if (dayTokQuota !== null && used.tokens >= dayTokQuota) {
      return overLimit(
        429,
        "quota_exceeded",
        `Daily token quota exhausted: ${used.tokens}/${dayTokQuota} tokens today`,
        secondsUntilUtcMidnight(nowSec)
      );
    }
  }
  return OK;
}

/** 上游调用前卡点: 禁用 Key 403, 限流/配额 429; DB 未绑定时直通 */
export async function checkRateAndQuota(env: Env, key: ResolvedGatewayKey): Promise<GateDecision> {
  if (!env.DB) return OK;

  if (key.source === "env") {
    // 环境变量 Key: 仅受全局默认限流约束 (可选), 无配额
    const globalRpm = intOr(env.DEFAULT_RATE_LIMIT_PER_MIN, null);
    if (globalRpm === null) return OK;
    return minuteGate(env, key.keyHash, globalRpm, null, null);
  }

  const r = key.record;
  if (!r.enabled) {
    return overLimit(403, "key_disabled", `Gateway key '${r.id}' is disabled`);
  }
  const rpm = r.rateLimitPerMin ?? intOr(env.DEFAULT_RATE_LIMIT_PER_MIN, null);
  return minuteGate(env, r.keyHash, rpm, r.dailyRequestQuota, r.dailyTokenQuota);
}

// ---------- 用量记录 ----------

export interface UsageTokens {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 异步写入请求日志 + 日聚合 (waitUntil 调用); 失败仅告警不影响响应 */
export async function recordUsage(
  env: Env,
  meta: UsageMeta,
  status: number,
  latencyMs: number,
  tokens: UsageTokens,
  error: string | null
): Promise<void> {
  if (!env.DB || env.USAGE_LOGGING === "off") return;
  try {
    const day = utcDay();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO request_logs
             (key_id, node, deployment, path, status, latency_ms, stream, prompt_tokens, completion_tokens, error)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          meta.keyId,
          meta.node,
          meta.deployment,
          meta.path,
          status,
          latencyMs,
          meta.stream ? 1 : 0,
          tokens.promptTokens,
          tokens.completionTokens,
          error
        ),
      env.DB.prepare(
        `INSERT INTO usage_daily (key_hash, day, requests, prompt_tokens, completion_tokens)
         VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(key_hash, day) DO UPDATE SET
           requests = requests + 1,
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens`
      ).bind(meta.keyHash, day, tokens.promptTokens ?? 0, tokens.completionTokens ?? 0),
    ]);
    // 低频 opportunistic 清理: 过期日志按 LOG_RETENTION_DAYS 滚动删除
    if (Math.random() < 0.02) {
      await env.DB
        .prepare("DELETE FROM request_logs WHERE ts < datetime('now', ?1)")
        .bind(`-${retentionDays(env)} days`)
        .run();
    }
  } catch (e) {
    console.warn("usage record failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * 从上游响应体提取 usage (在 tee 出的分支上消费, 不影响客户端流)。
 *  - JSON: 整体解析 usage 字段
 *  - SSE: 提取最后一帧中的 "usage":{...} (阶段一已注入 include_usage)
 */
export async function extractUsageFromResponse(
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  isStream: boolean
): Promise<UsageTokens> {
  const empty: UsageTokens = { promptTokens: null, completionTokens: null };
  try {
    const text = await new Response(body).text();
    if (isStream || (contentType ?? "").includes("event-stream")) {
      const matches = [...text.matchAll(/"usage"\s*:\s*\{[^{}]*\}/g)];
      if (matches.length === 0) return empty;
      const last = matches[matches.length - 1][0];
      const usage = JSON.parse(last.slice(last.indexOf("{"))) as {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      return {
        promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
        completionTokens:
          typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      };
    }
    const json = JSON.parse(text) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = json.usage;
    if (!u) return empty;
    return {
      promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
    };
  } catch {
    return empty;
  }
}

// ---------- 管理端统计 ----------

export interface UsageQuery {
  /** 回溯天数, 默认 7, 上限 90 */
  days?: number;
  /** 可选按 key_id 过滤 */
  keyId?: string;
}

function sinceClause(days: number): string {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return `${since} 00:00:00`;
}

export async function queryUsage(env: Env, q: UsageQuery) {
  const days = Math.min(Math.max(q.days ?? 7, 1), 90);
  const since = sinceClause(days);
  const keyFilter = q.keyId ? " AND key_id = ?2" : "";
  const binds = q.keyId ? [since, q.keyId] : [since];

  const summary = await env.DB!.prepare(
    `SELECT count(*) AS requests,
            COALESCE(sum(prompt_tokens), 0)     AS prompt_tokens,
            COALESCE(sum(completion_tokens), 0) AS completion_tokens,
            COALESCE(sum(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(avg(latency_ms), 0)        AS avg_latency_ms
       FROM request_logs WHERE ts >= ?1${keyFilter}`
  )
    .bind(...binds)
    .first<{
      requests: number;
      prompt_tokens: number;
      completion_tokens: number;
      errors: number;
      avg_latency_ms: number;
    }>();

  const byDay = await env.DB!.prepare(
    `SELECT substr(ts, 1, 10) AS day, count(*) AS requests,
            COALESCE(sum(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(sum(completion_tokens), 0) AS completion_tokens
       FROM request_logs WHERE ts >= ?1${keyFilter}
      GROUP BY day ORDER BY day`
  )
    .bind(...binds)
    .all();

  const byKey = await env.DB!.prepare(
    `SELECT key_id, count(*) AS requests,
            COALESCE(sum(prompt_tokens + completion_tokens), 0) AS tokens,
            COALESCE(sum(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
       FROM request_logs WHERE ts >= ?1${keyFilter}
      GROUP BY key_id ORDER BY requests DESC`
  )
    .bind(...binds)
    .all();

  const byDeployment = await env.DB!.prepare(
    `SELECT deployment, count(*) AS requests,
            COALESCE(sum(prompt_tokens + completion_tokens), 0) AS tokens
       FROM request_logs WHERE ts >= ?1${keyFilter} AND deployment IS NOT NULL
      GROUP BY deployment ORDER BY requests DESC`
  )
    .bind(...binds)
    .all();

  return {
    days,
    summary,
    byDay: byDay.results ?? [],
    byKey: byKey.results ?? [],
    byDeployment: byDeployment.results ?? [],
  };
}

export async function queryUsageLogs(
  env: Env,
  opts: { limit?: number; keyId?: string } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where = opts.keyId ? "WHERE key_id = ?2" : "";
  const binds = opts.keyId ? [limit, opts.keyId] : [limit];
  const res = await env.DB!.prepare(
    `SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ?1`
  )
    .bind(...binds)
    .all();
  return res.results ?? [];
}

/** 手动清理 N 天前日志, 返回删除行数 */
export async function purgeUsageLogs(env: Env, days: number): Promise<number> {
  const res = await env.DB!
    .prepare("DELETE FROM request_logs WHERE ts < datetime('now', ?1)")
    .bind(`-${Math.max(days, 1)} days`)
    .run();
  return res.meta?.changes ?? 0;
}



