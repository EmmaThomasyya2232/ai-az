import type { Env } from "../types";

/**
 * 阶段五: 节点熔断状态机 (D1 持久化, 跨 isolate 共享)。
 *
 * 状态机:
 *   closed --连续失败 >= 阈值--> open --冷却到期(原子抢占)--> half_open
 *   half_open --成功--> 删除状态行(恢复 closed) / --失败--> 重新 open (重新计时)
 *
 * 依赖 DB 绑定; 未绑定或 BREAKER_ENABLED=off 时为无操作,
 * 网关行为回落阶段四 (仅节点间故障转移, 不熔断)。
 */

export type BreakerState = "closed" | "open" | "half_open";

interface HealthRow {
  node_name: string;
  state: BreakerState;
  failures: number;
  opened_at: number | null; // epoch 毫秒
  last_error: string | null;
  last_probed_at: string | null;
  updated_at: string;
}

export interface HealthSnapshot {
  nodeName: string;
  state: BreakerState;
  failures: number;
  /** 熔断打开时刻 (epoch 毫秒) */
  openedAt: number | null;
  lastError: string | null;
  lastProbedAt: string | null;
  updatedAt: string;
}

export interface RouteDecision {
  allow: boolean;
  state: BreakerState | "none";
  /** 不放行时建议的 Retry-After 秒数 (按剩余冷却计算) */
  retryAfterSec?: number;
}

export interface FailureOutcome {
  state: BreakerState;
  /** 本次调用是否触发了 -> open 的迁移 (用于告警去重) */
  opened: boolean;
}

export interface SuccessOutcome {
  /** 本次调用是否触发了 -> closed 的迁移 (用于告警去重) */
  closed: boolean;
}

export function breakerEnabled(env: Env): boolean {
  return env.BREAKER_ENABLED !== "off" && !!env.DB;
}

export function breakerThreshold(env: Env): number {
  const n = Math.floor(Number(env.BREAKER_FAILURE_THRESHOLD ?? 3));
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export function breakerCooldownSec(env: Env): number {
  const n = Math.floor(Number(env.BREAKER_COOLDOWN_SEC ?? 120));
  return Number.isFinite(n) && n >= 1 ? n : 120;
}

function toSnapshot(row: HealthRow): HealthSnapshot {
  return {
    nodeName: row.node_name,
    state: row.state,
    failures: row.failures,
    openedAt: row.opened_at,
    lastError: row.last_error,
    lastProbedAt: row.last_probed_at,
    updatedAt: row.updated_at,
  };
}

async function getRow(env: Env, nodeName: string): Promise<HealthRow | null> {
  try {
    return await env.DB!
      .prepare(
        "SELECT node_name, state, failures, opened_at, last_error, last_probed_at, updated_at FROM node_health WHERE node_name = ?1"
      )
      .bind(nodeName)
      .first<HealthRow>();
  } catch (e) {
    console.warn("breaker read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 全部熔断状态 (管理面板用); D1 不可用时返回空数组 */
export async function listBreakers(env: Env): Promise<HealthSnapshot[]> {
  if (!env.DB) return [];
  try {
    const res = await env.DB
      .prepare(
        "SELECT node_name, state, failures, opened_at, last_error, last_probed_at, updated_at FROM node_health ORDER BY node_name"
      )
      .all<HealthRow>();
    return (res.results ?? []).map(toSnapshot);
  } catch (e) {
    console.warn("breaker list failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * 单节点放行判定:
 *   closed / 无记录 -> 放行;
 *   open 且冷却已过 -> 原子抢占迁移 half_open 并放行 (并发下只有一个请求赢得探测);
 *   open 冷却未过   -> 拒绝, 返回剩余冷却秒数;
 *   half_open       -> 放行 (探测; 失败会立即重新熔断)。
 */
export async function routeDecision(env: Env, nodeName: string): Promise<RouteDecision> {
  const row = await getRow(env, nodeName);
  if (!row) return { allow: true, state: "none" };
  if (row.state === "closed") return { allow: true, state: "closed" };
  if (row.state === "half_open") return { allow: true, state: "half_open" };

  const cooldownMs = breakerCooldownSec(env) * 1000;
  const elapsed = Date.now() - (row.opened_at ?? 0);
  if (elapsed < cooldownMs) {
    return {
      allow: false,
      state: "open",
      retryAfterSec: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)),
    };
  }
  // 冷却到期: 抢占式半开
  try {
    const res = await env.DB!
      .prepare(
        "UPDATE node_health SET state = 'half_open', updated_at = datetime('now') WHERE node_name = ?1 AND state = 'open' AND opened_at <= ?2"
      )
      .bind(nodeName, Date.now() - cooldownMs)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return { allow: true, state: "half_open" };
  } catch (e) {
    console.warn("breaker half-open claim failed:", e instanceof Error ? e.message : e);
  }
  return { allow: false, state: "open", retryAfterSec: 1 };
}

/** 记录一次上游失败; 达到阈值时打开熔断 */
export async function recordFailure(
  env: Env,
  nodeName: string,
  error: string,
  opts: { threshold?: number } = {}
): Promise<FailureOutcome> {
  const row = await getRow(env, nodeName);
  const before = row?.state ?? "closed";
  if (before === "open") return { state: "open", opened: false }; // 冷却期内不重复计数

  const threshold = opts.threshold ?? breakerThreshold(env);
  const failures = (row?.failures ?? 0) + 1;
  const open = failures >= threshold;
  const state: BreakerState = open ? "open" : "closed";
  const openedAt = open ? Date.now() : (row?.opened_at ?? null);
  try {
    await env.DB!
      .prepare(
        `INSERT INTO node_health (node_name, state, failures, opened_at, last_error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(node_name) DO UPDATE SET
           state = excluded.state, failures = excluded.failures,
           opened_at = excluded.opened_at, last_error = excluded.last_error,
           updated_at = datetime('now')`
      )
      .bind(nodeName, state, failures, openedAt, error.slice(0, 500))
      .run();
  } catch (e) {
    console.warn("breaker write failed:", e instanceof Error ? e.message : e);
    return { state: before, opened: false };
  }
  return { state, opened: open };
}

/** 记录一次上游成功: 清零计数并关闭熔断 (半开探测成功即恢复) */
export async function recordSuccess(env: Env, nodeName: string): Promise<SuccessOutcome> {
  const row = await getRow(env, nodeName);
  if (!row) return { closed: false };
  try {
    await env.DB!.prepare("DELETE FROM node_health WHERE node_name = ?1").bind(nodeName).run();
  } catch (e) {
    console.warn("breaker close failed:", e instanceof Error ? e.message : e);
    return { closed: false };
  }
  return { closed: row.state !== "closed" };
}

/** 手动复位 (管理面板/运维): 删除状态行, 熔断器回到 closed */
export async function resetBreaker(env: Env, nodeName: string): Promise<boolean> {
  const res = await env.DB!.prepare("DELETE FROM node_health WHERE node_name = ?1").bind(nodeName).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 巡检探活后更新 last_probed_at (不改变状态机) */
export async function markProbed(env: Env, nodeName: string): Promise<void> {
  try {
    await env.DB!
      .prepare(
        `INSERT INTO node_health (node_name, state, failures, opened_at, last_probed_at, updated_at)
         VALUES (?1, 'closed', 0, NULL, datetime('now'), datetime('now'))
         ON CONFLICT(node_name) DO UPDATE SET last_probed_at = datetime('now')`
      )
      .bind(nodeName)
      .run();
  } catch (e) {
    console.warn("breaker probe mark failed:", e instanceof Error ? e.message : e);
  }
}
