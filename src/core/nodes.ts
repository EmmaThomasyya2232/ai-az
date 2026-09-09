import type { Env } from "../types";
import { decryptSecret, encryptSecret } from "./crypto";

/** D1 nodes 表行结构 */
interface NodeRow {
  name: string;
  endpoint: string;
  api_key_enc: string;
  deployments: string;
  weight: number;
  enabled: number;
  updated_at: string;
}

/** 节点记录 (apiKey 为解密后的运行时明文, 仅服务端内部使用, 对外一律脱敏) */
export interface NodeRecord {
  name: string;
  endpoint: string;
  apiKey: string;
  deployments: Record<string, string>;
  weight: number;
  enabled: boolean;
  updatedAt?: string;
}

/**
 * 从 D1 读取全部节点并解密凭据。
 * 返回 null 表示 D1 暂不可用 (未绑定/表不存在), 调用方应回落环境变量;
 * 凭据解密失败属于配置错误, 直接向上抛出。
 */
export async function listNodesFromD1(env: Env): Promise<NodeRecord[] | null> {
  if (!env.DB) return null;
  let rows: NodeRow[];
  try {
    const res = await env.DB
      .prepare(
        "SELECT name, endpoint, api_key_enc, deployments, weight, enabled, updated_at FROM nodes ORDER BY name"
      )
      .all<NodeRow>();
    rows = res.results ?? [];
  } catch (e) {
    console.warn(
      "D1 node pool unavailable, falling back to AZURE_NODES env:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
  const out: NodeRecord[] = [];
  for (const row of rows) {
    out.push(await rowToRecord(env, row));
  }
  return out;
}

/** 按名称读取单个节点, 不存在或 D1 不可用时返回 null (解密失败仍抛出) */
export async function getNodeFromD1(env: Env, name: string): Promise<NodeRecord | null> {
  if (!env.DB) return null;
  let row: NodeRow | null;
  try {
    row = await env.DB
      .prepare(
        "SELECT name, endpoint, api_key_enc, deployments, weight, enabled, updated_at FROM nodes WHERE name = ?1"
      )
      .bind(name)
      .first<NodeRow>();
  } catch (e) {
    console.warn("D1 node lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
  return row ? rowToRecord(env, row) : null;
}

async function rowToRecord(env: Env, row: NodeRow): Promise<NodeRecord> {
  return {
    name: row.name,
    endpoint: row.endpoint,
    apiKey: await decryptSecret(env, row.api_key_enc),
    deployments: JSON.parse(row.deployments) as Record<string, string>,
    weight: row.weight,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

/** 写入节点 (INSERT ... ON CONFLICT UPSERT), 凭据 AES-GCM 加密后落库 */
export async function upsertNode(env: Env, rec: NodeRecord): Promise<void> {
  const api_key_enc = await encryptSecret(env, rec.apiKey);
  await env.DB!.prepare(
    `INSERT INTO nodes (name, endpoint, api_key_enc, deployments, weight, enabled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       endpoint = excluded.endpoint,
       api_key_enc = excluded.api_key_enc,
       deployments = excluded.deployments,
       weight = excluded.weight,
       enabled = excluded.enabled,
       updated_at = datetime('now')`
  )
    .bind(
      rec.name,
      rec.endpoint,
      api_key_enc,
      JSON.stringify(rec.deployments),
      rec.weight ?? 1,
      rec.enabled === false ? 0 : 1
    )
    .run();
}

/** 删除节点, 返回是否确实删除了记录 */
export async function deleteNodeFromD1(env: Env, name: string): Promise<boolean> {
  const res = await env.DB!.prepare("DELETE FROM nodes WHERE name = ?1").bind(name).run();
  return (res.meta?.changes ?? 0) > 0;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * 校验管理 API 的节点输入。
 * partial=false (POST): name/endpoint/apiKey/deployments 必填;
 * partial=true  (PUT): 全部可选, 仅校验出现的字段。
 */
export function validateNodeInput(
  raw: unknown,
  opts: { partial?: boolean } = {}
): { ok: true; value: Partial<NodeRecord> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const partial = opts.partial === true;
  const value: Partial<NodeRecord> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !NAME_RE.test(body.name)) {
      return { ok: false, message: "`name` must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/" };
    }
    value.name = body.name;
  } else if (!partial) {
    return { ok: false, message: "`name` is required" };
  }

  if (body.endpoint !== undefined) {
    if (typeof body.endpoint !== "string") {
      return { ok: false, message: "`endpoint` must be a string" };
    }
    let u: URL;
    try {
      u = new URL(body.endpoint);
    } catch {
      return { ok: false, message: "`endpoint` must be a valid URL" };
    }
    if (u.protocol !== "https:") {
      return { ok: false, message: "`endpoint` must use https" };
    }
    value.endpoint = u.origin; // 去除路径与尾部斜杠
  } else if (!partial) {
    return { ok: false, message: "`endpoint` is required" };
  }

  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || body.apiKey.trim() === "") {
      return { ok: false, message: "`apiKey` must be a non-empty string" };
    }
    value.apiKey = body.apiKey.trim();
  } else if (!partial) {
    return { ok: false, message: "`apiKey` is required" };
  }

  if (body.deployments !== undefined) {
    const d = body.deployments;
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      return { ok: false, message: "`deployments` must be an object of { alias: deployment }" };
    }
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, message: `deployments['${k}'] must be a non-empty deployment name` };
      }
      map[k] = v.trim();
    }
    if (Object.keys(map).length === 0) {
      return { ok: false, message: "`deployments` must contain at least one mapping" };
    }
    value.deployments = map;
  } else if (!partial) {
    return { ok: false, message: "`deployments` is required" };
  }

  if (body.weight !== undefined) {
    const n = Math.floor(Number(body.weight));
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      return { ok: false, message: "`weight` must be an integer in [1, 10]" };
    }
    value.weight = n;
  } else if (!partial) {
    value.weight = 1; // 默认权重
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, message: "`enabled` must be a boolean" };
    }
    value.enabled = body.enabled;
  } else if (!partial) {
    value.enabled = true; // 默认启用
  }

  return { ok: true, value };
}
