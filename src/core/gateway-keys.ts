import type { Env } from "../types";
import { sha256Hex } from "./crypto";

/**
 * 阶段三: D1 化网关 Key (只存 SHA-256 摘要, 明文仅创建时返回一次)。
 * 解析优先级: D1 gateway_keys 精确摘要命中 -> 回落 GATEWAY_KEYS 环境变量 (阶段一行为)。
 */

export interface GatewayKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  keySuffix: string;
  label?: string;
  enabled: boolean;
  rateLimitPerMin: number | null;
  dailyRequestQuota: number | null;
  dailyTokenQuota: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/** 网关鉴权解析结果 (挂到 hono c.set("gwKey")) */
export type ResolvedGatewayKey =
  | { source: "d1"; record: GatewayKeyRecord }
  | { source: "env"; id: string; keyHash: string };

interface KeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  label: string | null;
  enabled: number;
  rate_limit_per_min: number | null;
  daily_request_quota: number | null;
  daily_token_quota: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: KeyRow): GatewayKeyRecord {
  return {
    id: row.id,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    label: row.label ?? undefined,
    enabled: row.enabled === 1,
    rateLimitPerMin: row.rate_limit_per_min,
    dailyRequestQuota: row.daily_request_quota,
    dailyTokenQuota: row.daily_token_quota,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 环境变量回落 Key 的稳定标识 (用于日志归因): env-<摘要前12位> */
function envKeyId(keyHash: string): string {
  return `env-${keyHash.slice(0, 12)}`;
}

function envKeyList(env: Env): string[] {
  return (env.GATEWAY_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface GatewayKeyInput {
  label?: string;
  rateLimitPerMin?: number | null;
  dailyRequestQuota?: number | null;
  dailyTokenQuota?: number | null;
}

function intOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000_000_000) {
    return null; // 非法
  }
  return v;
}

/** 校验管理 API 的 Key 输入; partial=true 时全部可选 */
export function validateKeyInput(
  raw: unknown,
  opts: { partial?: boolean } = {}
): { ok: true; value: GatewayKeyInput } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const value: GatewayKeyInput = {};

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length > 128) {
      return { ok: false, message: "`label` must be a string (max 128)" };
    }
    value.label = body.label;
  }

  const limitFields = ["rateLimitPerMin", "dailyRequestQuota", "dailyTokenQuota"] as const;
  for (const field of limitFields) {
    const parsed = intOrNull(body[field]);
    if (parsed === null && body[field] !== undefined && body[field] !== null) {
      return { ok: false, message: `\`${field}\` must be a positive integer or null` };
    }
    if (parsed !== undefined) {
      (value as Record<string, unknown>)[field] = parsed;
    }
  }

  if (!opts.partial) {
    for (const field of limitFields) {
      if ((value as Record<string, unknown>)[field] === undefined) {
        (value as Record<string, unknown>)[field] = null; // POST 缺省 = 不限
      }
    }
  }
  return { ok: true, value };
}

/** 生成新网关 Key: sk-az- + 32 位随机 hex */
function generateGatewayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk-az-${hex}`;
}

export const GATEWAY_KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
void GATEWAY_KEY_ID_RE; // 预留: 未来支持自定义 Key id 时启用校验

/**
 * 解析请求携带的 Key。
 * 命中 D1 -> { source:'d1', record } (调用方自行判断 enabled);
 * 未命中但匹配 GATEWAY_KEYS -> { source:'env' } (不限流不配额, 阶段一行为);
 * 都未命中 -> null。
 */
export async function resolveGatewayKey(
  env: Env,
  provided: string
): Promise<ResolvedGatewayKey | null> {
  const keyHash = await sha256Hex(provided);

  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE key_hash = ?1")
        .bind(keyHash)
        .first<KeyRow>();
      if (row) return { source: "d1", record: rowToRecord(row) };
    } catch (e) {
      console.warn("gateway key lookup failed:", e instanceof Error ? e.message : e);
    }
  }

  for (const key of envKeyList(env)) {
    if (keyHash === (await sha256Hex(key))) {
      return { source: "env", id: envKeyId(keyHash), keyHash };
    }
  }
  return null;
}

/** D1 中是否存在已登记的 Key (用于区分 401 invalid 与 500 not configured) */
export async function hasD1GatewayKeys(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM gateway_keys").first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export function envGatewayKeysConfigured(env: Env): boolean {
  return envKeyList(env).length > 0;
}

/** 创建 Key: 返回记录与一次性明文 */
export async function createGatewayKey(
  env: Env,
  input: GatewayKeyInput
): Promise<{ record: GatewayKeyRecord; plaintext: string }> {
  if (!env.DB) throw new Error("DB is not configured");
  const rand = crypto.getRandomValues(new Uint8Array(3));
  const id = `key-${Date.now().toString(36)}-${[...rand].map((b) => b.toString(36)).join("")}`;
  const plaintext = generateGatewayKey();
  const keyHash = await sha256Hex(plaintext);
  const record: GatewayKeyRecord = {
    id,
    keyHash,
    keyPrefix: plaintext.slice(0, 8),
    keySuffix: plaintext.slice(-4),
    label: input.label,
    enabled: true,
    rateLimitPerMin: input.rateLimitPerMin ?? null,
    dailyRequestQuota: input.dailyRequestQuota ?? null,
    dailyTokenQuota: input.dailyTokenQuota ?? null,
  };
  await env.DB
    .prepare(
      `INSERT INTO gateway_keys
         (id, key_hash, key_prefix, key_suffix, label, enabled,
          rate_limit_per_min, daily_request_quota, daily_token_quota)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)`
    )
    .bind(
      record.id,
      record.keyHash,
      record.keyPrefix,
      record.keySuffix,
      record.label ?? null,
      record.rateLimitPerMin,
      record.dailyRequestQuota,
      record.dailyTokenQuota
    )
    .run();
  return { record, plaintext };
}

export async function listGatewayKeysFromD1(env: Env): Promise<GatewayKeyRecord[] | null> {
  if (!env.DB) return null;
  try {
    const res = await env.DB.prepare("SELECT * FROM gateway_keys ORDER BY created_at, id").all<KeyRow>();
    return (res.results ?? []).map(rowToRecord);
  } catch (e) {
    console.warn("gateway key list failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getGatewayKeyFromD1(env: Env, id: string): Promise<GatewayKeyRecord | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE id = ?1").bind(id).first<KeyRow>();
    return row ? rowToRecord(row) : null;
  } catch (e) {
    console.warn("gateway key lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 部分更新 (PATCH 语义); 返回更新后记录, 不存在返回 null */
export async function updateGatewayKey(
  env: Env,
  id: string,
  patch: GatewayKeyInput & { enabled?: boolean }
): Promise<GatewayKeyRecord | null> {
  const current = await getGatewayKeyFromD1(env, id);
  if (!current) return null;
  const next: GatewayKeyRecord = {
    ...current,
    label: patch.label !== undefined ? patch.label : current.label,
    rateLimitPerMin:
      patch.rateLimitPerMin !== undefined ? patch.rateLimitPerMin : current.rateLimitPerMin,
    dailyRequestQuota:
      patch.dailyRequestQuota !== undefined ? patch.dailyRequestQuota : current.dailyRequestQuota,
    dailyTokenQuota:
      patch.dailyTokenQuota !== undefined ? patch.dailyTokenQuota : current.dailyTokenQuota,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
  };
  await env.DB!
    .prepare(
      `UPDATE gateway_keys SET label=?2, rate_limit_per_min=?3, daily_request_quota=?4,
         daily_token_quota=?5, enabled=?6, updated_at=datetime('now')
       WHERE id=?1`
    )
    .bind(
      id,
      next.label ?? null,
      next.rateLimitPerMin,
      next.dailyRequestQuota,
      next.dailyTokenQuota,
      next.enabled ? 1 : 0
    )
    .run();
  return next;
}

export async function deleteGatewayKeyFromD1(env: Env, id: string): Promise<boolean> {
  const res = await env.DB!.prepare("DELETE FROM gateway_keys WHERE id = ?1").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

