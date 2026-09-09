import type { Env } from "../types";
import { decryptSecret, encryptSecret } from "./crypto";

/** D1 service_principals 表行结构 */
interface SpRow {
  id: string;
  tenant_id: string;
  client_id: string;
  secret_enc: string;
  label: string | null;
  updated_at: string;
}

/** 服务主体记录 (clientSecret 为解密后的运行时明文, 仅服务端内部使用, 对外一律脱敏) */
export interface SpRecord {
  id: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  label?: string;
  updatedAt?: string;
}

async function rowToRecord(env: Env, row: SpRow): Promise<SpRecord> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    clientSecret: await decryptSecret(env, row.secret_enc),
    label: row.label ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * 从 D1 读取全部服务主体。D1 不可用时返回 null (调用方自行处理);
 * 凭据解密失败属于配置错误, 直接向上抛出。
 */
export async function listSpsFromD1(env: Env): Promise<SpRecord[] | null> {
  if (!env.DB) return null;
  let rows: SpRow[];
  try {
    const res = await env.DB
      .prepare(
        "SELECT id, tenant_id, client_id, secret_enc, label, updated_at FROM service_principals ORDER BY id"
      )
      .all<SpRow>();
    rows = res.results ?? [];
  } catch (e) {
    console.warn("D1 sp list failed:", e instanceof Error ? e.message : e);
    return null;
  }
  const out: SpRecord[] = [];
  for (const row of rows) out.push(await rowToRecord(env, row));
  return out;
}

/** 按读取单个服务主体, 不存在或 D1 不可用时返回 null (解密失败仍抛出) */
export async function getSpFromD1(env: Env, id: string): Promise<SpRecord | null> {
  if (!env.DB) return null;
  let row: SpRow | null;
  try {
    row = await env.DB
      .prepare(
        "SELECT id, tenant_id, client_id, secret_enc, label, updated_at FROM service_principals WHERE id = ?1"
      )
      .bind(id)
      .first<SpRow>();
  } catch (e) {
    console.warn("D1 sp lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
  return row ? rowToRecord(env, row) : null;
}

/** 写入服务主体 (UPSERT), client_secret AES-GCM 加密后落库 */
export async function upsertSp(env: Env, rec: SpRecord): Promise<void> {
  const secret_enc = await encryptSecret(env, rec.clientSecret);
  await env.DB!.prepare(
    `INSERT INTO service_principals (id, tenant_id, client_id, secret_enc, label, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       client_id = excluded.client_id,
       secret_enc = excluded.secret_enc,
       label = excluded.label,
       updated_at = datetime('now')`
  )
    .bind(rec.id, rec.tenantId, rec.clientId, secret_enc, rec.label ?? null)
    .run();
}

/** 删除服务主体, 返回是否确实删除了记录 */
export async function deleteSpFromD1(env: Env, id: string): Promise<boolean> {
  const res = await env.DB!.prepare("DELETE FROM service_principals WHERE id = ?1").bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function requireNonEmpty(v: unknown, field: string, max = 256): string | null {
  if (typeof v !== "string" || v.trim() === "" || v.length > max) return null;
  return v.trim();
}

/**
 * 校验管理 API 的服务主体输入。
 * partial=false (POST): id/tenantId/clientId/clientSecret 必填;
 * partial=true  (PUT): 全部可选, 仅校验出现的字段。
 */
export function validateSpInput(
  raw: unknown,
  opts: { partial?: boolean } = {}
): { ok: true; value: Partial<SpRecord> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const partial = opts.partial === true;
  const value: Partial<SpRecord> = {};

  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !ID_RE.test(body.id)) {
      return { ok: false, message: "`id` must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/" };
    }
    value.id = body.id;
  } else if (!partial) {
    return { ok: false, message: "`id` is required" };
  }

  const fields: Array<[string, keyof SpRecord, number]> = [
    ["tenantId", "tenantId", 128],
    ["clientId", "clientId", 128],
    ["clientSecret", "clientSecret", 1024],
  ];
  for (const [key, prop, max] of fields) {
    if (body[key] !== undefined) {
      const v = requireNonEmpty(body[key], key, max);
      if (v === null) {
        return { ok: false, message: `\`${key}\` must be a non-empty string (max ${max})` };
      }
      (value as Record<string, unknown>)[prop] = v;
    } else if (!partial) {
      return { ok: false, message: `\`${key}\` is required` };
    }
  }

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length > 128) {
      return { ok: false, message: "`label` must be a string (max 128)" };
    }
    value.label = body.label;
  }

  return { ok: true, value };
}
