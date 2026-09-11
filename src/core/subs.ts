import type { Env } from "../types";
import { defaultArmBase, armScope } from "./arm";
import { getAccessToken } from "./token-cache";
import type { SpRecord } from "./sp";

/**
 * 阶段六: 订阅资产画像 (azure_subscriptions 表)。
 * 服务主体录入时通过 ARM /subscriptions 自动发现并入库,
 * 之后承载 current_tier / allowed_regions / warmup_status 等养号资产状态。
 */

/** D1 azure_subscriptions 表行结构 */
interface SubRow {
  id: string;
  sp_id: string;
  subscription_name: string;
  current_tier: string;
  allowed_regions: string | null;
  warmup_status: string;
  warmup_target: number;
  upgrade_unavailability_reason: string | null;
  last_tier_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 订阅记录 (对外视图) */
export interface SubRecord {
  id: string;
  spId: string;
  name: string;
  currentTier: string;
  allowedRegions: string[] | null;
  warmupStatus: string;
  warmupTarget: boolean;
  upgradeUnavailabilityReason: string | null;
  lastTierCheckedAt: string | null;
  updatedAt?: string;
}

export type WarmupStatus = "Pending" | "Active" | "Upgraded" | "Disabled";

export const WARMUP_STATUSES: WarmupStatus[] = ["Pending", "Active", "Upgraded", "Disabled"];

export function isWarmupStatus(v: unknown): v is WarmupStatus {
  return typeof v === "string" && (WARMUP_STATUSES as string[]).includes(v);
}

function rowToRecord(row: SubRow): SubRecord {
  let allowedRegions: string[] | null = null;
  if (row.allowed_regions !== null && row.allowed_regions.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(row.allowed_regions);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        allowedRegions = parsed;
      }
    } catch {
      allowedRegions = null;
    }
  }
  return {
    id: row.id,
    spId: row.sp_id,
    name: row.subscription_name,
    currentTier: row.current_tier,
    allowedRegions,
    warmupStatus: row.warmup_status,
    warmupTarget: row.warmup_target === 1,
    upgradeUnavailabilityReason: row.upgrade_unavailability_reason,
    lastTierCheckedAt: row.last_tier_checked_at,
    updatedAt: row.updated_at,
  };
}

function defaultSubRecord(id: string, spId: string, name: string): SubRecord {
  return {
    id,
    spId,
    name,
    currentTier: "Unknown",
    allowedRegions: null,
    warmupStatus: "Pending",
    warmupTarget: false,
    upgradeUnavailabilityReason: null,
    lastTierCheckedAt: null,
  };
}

/** 列出全部已入库订阅 (按更新时间倒序) */
export async function listSubsFromD1(env: Env): Promise<SubRecord[] | null> {
  if (!env.DB) return null;
  try {
    const res = await env.DB
      .prepare(
        `SELECT id, sp_id, subscription_name, current_tier, allowed_regions, warmup_status,
                warmup_target, upgrade_unavailability_reason, last_tier_checked_at, created_at, updated_at
         FROM azure_subscriptions ORDER BY updated_at DESC`
      )
      .all<SubRow>();
    return (res.results ?? []).map(rowToRecord);
  } catch (e) {
    console.warn("D1 subs list failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 按订阅 ID 读取单个订阅画像, 不存在返回 null */
export async function getSubFromD1(env: Env, id: string): Promise<SubRecord | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB
      .prepare(
        `SELECT id, sp_id, subscription_name, current_tier, allowed_regions, warmup_status,
                warmup_target, upgrade_unavailability_reason, last_tier_checked_at, created_at, updated_at
         FROM azure_subscriptions WHERE id = ?1`
      )
      .bind(id)
      .first<SubRow>();
    return row ? rowToRecord(row) : null;
  } catch (e) {
    console.warn("D1 sub lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 写入订阅 (UPSERT), 仅更新本记录公开字段 */
export async function upsertSub(env: Env, rec: SubRecord): Promise<void> {
  await env.DB!.prepare(
    `INSERT INTO azure_subscriptions
       (id, sp_id, subscription_name, current_tier, allowed_regions, warmup_status, warmup_target,
        upgrade_unavailability_reason, last_tier_checked_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       sp_id = excluded.sp_id,
       subscription_name = excluded.subscription_name,
       current_tier = excluded.current_tier,
       allowed_regions = excluded.allowed_regions,
       warmup_status = excluded.warmup_status,
       warmup_target = excluded.warmup_target,
       upgrade_unavailability_reason = excluded.upgrade_unavailability_reason,
       last_tier_checked_at = excluded.last_tier_checked_at,
       updated_at = datetime('now')`
  )
    .bind(
      rec.id,
      rec.spId,
      rec.name ?? "",
      rec.currentTier ?? "Unknown",
      rec.allowedRegions !== null ? JSON.stringify(rec.allowedRegions) : null,
      rec.warmupStatus ?? "Pending",
      rec.warmupTarget ? 1 : 0,
      rec.upgradeUnavailabilityReason ?? null,
      rec.lastTierCheckedAt ?? null
    )
    .run();
}

/** 仅更新动态字段 (Tier / 区域 / 打卡状态) 而不触碰原始订阅名, 供养号流程使用 */
export async function patchSubState(
  env: Env,
  id: string,
  patch: Partial<Pick<SubRecord, "currentTier" | "allowedRegions" | "warmupStatus" | "warmupTarget" | "upgradeUnavailabilityReason" | "lastTierCheckedAt">>
): Promise<void> {
  const cur = await getSubFromD1(env, id);
  if (!cur) return;
  await upsertSub(env, {
    ...cur,
    ...patch,
  });
}

/** 删除订阅画像 */
export async function deleteSubFromD1(env: Env, id: string): Promise<boolean> {
  const res = await env.DB!.prepare("DELETE FROM azure_subscriptions WHERE id = ?1").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * ARM 订阅穿透: 拉取服务主体可访问的所有订阅并 UPSERT 入库。
 * @returns 入库后的订阅记录数组; 网络/令牌错误向上抛出 (调用方转为 502) 
 */
export async function syncSubscriptionsFromArm(
  env: Env,
  sp: SpRecord
): Promise<SubRecord[]> {
  const url = new URL(defaultArmBase(env) + "/subscriptions");
  url.searchParams.set("api-version", "2022-12-01");
  const token = await getAccessToken(env, {
    tenantId: sp.tenantId,
    clientId: sp.clientId,
    clientSecret: sp.clientSecret,
    scope: armScope(env),
  });
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${token.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ARM list subscriptions failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { value?: Array<{ subscriptionId?: string; displayName?: string }> };
  const subs: SubRecord[] = [];
  for (const item of data.value ?? []) {
    if (!item.subscriptionId) continue;
    let record = (await getSubFromD1(env, item.subscriptionId)) ??
      defaultSubRecord(item.subscriptionId, sp.id, item.displayName ?? "");
    record = { ...record, spId: sp.id, name: item.displayName ?? record.name };
    await upsertSub(env, record);
    subs.push(record);
  }
  return subs;
}
