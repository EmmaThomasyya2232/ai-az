import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import { requireAdminToken } from "../core/auth";
import { maskSecret } from "../core/crypto";
import {
  listNodesFromD1,
  getNodeFromD1,
  upsertNode,
  deleteNodeFromD1,
  validateNodeInput,
  type NodeRecord,
} from "../core/nodes";
import {
  listSpsFromD1,
  getSpFromD1,
  upsertSp,
  deleteSpFromD1,
  validateSpInput,
  type SpRecord,
} from "../core/sp";
import {
  getAccessToken,
  evictToken,
  evictSpTokens,
  defaultAuthority,
} from "../core/token-cache";
import {
  armRequest,
  armScope,
  defaultArmBase,
  ArmError,
} from "../core/arm";
import {
  listGatewayKeysFromD1,
  createGatewayKey,
  updateGatewayKey,
  deleteGatewayKeyFromD1,
  validateKeyInput,
  type GatewayKeyRecord,
  type GatewayKeyInput,
} from "../core/gateway-keys";
import { queryUsage, queryUsageLogs, purgeUsageLogs } from "../core/usage";


export const admin = new Hono<{ Bindings: Env }>();

admin.get("/health", (c) =>
  c.json({ ok: true, service: "azure-ai-manager", time: new Date().toISOString() })
);

// ---------- 节点池管理 (Phase 2, D1 持久层, 凭据 AES-GCM 加密) ----------

admin.use("/nodes", requireAdminToken);
admin.use("/nodes/*", requireAdminToken);

function toPublic(rec: NodeRecord) {
  return {
    name: rec.name,
    endpoint: rec.endpoint,
    apiKeyMasked: maskSecret(rec.apiKey),
    deployments: rec.deployments,
    weight: rec.weight,
    enabled: rec.enabled,
    updatedAt: rec.updatedAt ?? null,
  };
}

function dbNotConfigured(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: {
        message:
          "D1 binding `DB` is not configured. Create a database (`wrangler d1 create azure-ai-manager`), set database_id in wrangler.jsonc and apply migrations.",
        type: "config_error",
      },
    },
    500
  );
}

function invalid(c: Context<{ Bindings: Env }>, status: ContentfulStatusCode, message: string) {
  const type = status === 409 ? "conflict" : status === 404 ? "not_found" : "validation_error";
  return c.json({ error: { message, type } }, status);
}

async function readJsonBody(c: Context<{ Bindings: Env }>): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** 列出全部节点 (凭据脱敏) */
admin.get("/nodes", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const records = (await listNodesFromD1(c.env)) ?? [];
  return c.json({ ok: true, count: records.length, nodes: records.map(toPublic) });
});

/** 读取单个节点 (凭据脱敏) */
admin.get("/nodes/:name", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const name = c.req.param("name");
  const rec = await getNodeFromD1(c.env, name);
  if (!rec) return invalid(c, 404, `Node '${name}' not found`);
  return c.json({ ok: true, node: toPublic(rec) });
});

/** 创建节点 (重复返回 409) */
admin.post("/nodes", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const body = await readJsonBody(c);
  if (body === null) return invalid(c, 400, "Request body must be valid JSON");
  const parsed = validateNodeInput(body);
  if (!parsed.ok) return invalid(c, 400, parsed.message);

  const name = parsed.value.name!;
  if (await getNodeFromD1(c.env, name)) {
    return invalid(c, 409, `Node '${name}' already exists`);
  }
  await upsertNode(c.env, parsed.value as NodeRecord);
  const created = await getNodeFromD1(c.env, name);
  return c.json({ ok: true, node: created ? toPublic(created) : null }, 201);
});

/** 更新节点 (部分更新: 省略 apiKey 表示保留原凭据) */
admin.put("/nodes/:name", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const name = c.req.param("name");
  const current = await getNodeFromD1(c.env, name);
  if (!current) return invalid(c, 404, `Node '${name}' not found`);

  const body = await readJsonBody(c);
  if (body === null) return invalid(c, 400, "Request body must be valid JSON");
  const parsed = validateNodeInput(body, { partial: true });
  if (!parsed.ok) return invalid(c, 400, parsed.message);

  const merged: NodeRecord = { ...current, ...parsed.value, name };
  await upsertNode(c.env, merged);
  const updated = await getNodeFromD1(c.env, name);
  return c.json({ ok: true, node: updated ? toPublic(updated) : null });
});

/** 删除节点 */
admin.delete("/nodes/:name", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const name = c.req.param("name");
  const deleted = await deleteNodeFromD1(c.env, name);
  if (!deleted) return invalid(c, 404, `Node '${name}' not found`);
  return c.json({ ok: true, deleted: name });
});

// ---------- 服务主体管理 (阶段二, Entra ID, client_secret AES-GCM 加密) ----------

admin.use("/sps", requireAdminToken);
admin.use("/sps/*", requireAdminToken);

function toSpPublic(rec: SpRecord) {
  return {
    id: rec.id,
    tenantId: rec.tenantId,
    clientId: rec.clientId,
    clientSecretMasked: maskSecret(rec.clientSecret),
    label: rec.label ?? null,
    updatedAt: rec.updatedAt ?? null,
  };
}

/** 列出全部服务主体 (凭据脱敏) */
admin.get("/sps", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const records = (await listSpsFromD1(c.env)) ?? [];
  return c.json({ ok: true, count: records.length, sps: records.map(toSpPublic) });
});

/** 读取单个服务主体 (凭据脱敏) */
admin.get("/sps/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const rec = await getSpFromD1(c.env, id);
  if (!rec) return invalid(c, 404, `Service principal '${id}' not found`);
  return c.json({ ok: true, sp: toSpPublic(rec) });
});

/** 创建服务主体 (重复返回 409) */
admin.post("/sps", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const body = await readJsonBody(c);
  if (body === null) return invalid(c, 400, "Request body must be valid JSON");
  const parsed = validateSpInput(body);
  if (!parsed.ok) return invalid(c, 400, parsed.message);

  const id = parsed.value.id!;
  if (await getSpFromD1(c.env, id)) {
    return invalid(c, 409, `Service principal '${id}' already exists`);
  }
  await upsertSp(c.env, parsed.value as SpRecord);
  const created = await getSpFromD1(c.env, id);
  return c.json({ ok: true, sp: created ? toSpPublic(created) : null }, 201);
});

/** 更新服务主体 (部分更新: 省略 clientSecret 表示保留原凭据) */
admin.put("/sps/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const current = await getSpFromD1(c.env, id);
  if (!current) return invalid(c, 404, `Service principal '${id}' not found`);

  const body = await readJsonBody(c);
  if (body === null) return invalid(c, 400, "Request body must be valid JSON");
  const parsed = validateSpInput(body, { partial: true });
  if (!parsed.ok) return invalid(c, 400, parsed.message);

  const merged: SpRecord = { ...current, ...parsed.value, id };
  await upsertSp(c.env, merged);
  const updated = await getSpFromD1(c.env, id);
  return c.json({ ok: true, sp: updated ? toSpPublic(updated) : null });
});

/** 删除服务主体 (级联失效其全部令牌缓存) */
admin.delete("/sps/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const current = await getSpFromD1(c.env, id);
  if (!current) return invalid(c, 404, `Service principal '${id}' not found`);
  await deleteSpFromD1(c.env, id);
  await evictSpTokens(c.env, current.tenantId, current.clientId);
  return c.json({ ok: true, deleted: id });
});

/**
 * 获取访问令牌 (三层缓存): body 可选 { scope, refresh }。
 * scope 默认 https://management.azure.com/.default (ARM 管理面)。
 * 响应中令牌脱敏, 仅返回来源/过期时间。
 */
admin.post("/sps/:id/token", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const sp = await getSpFromD1(c.env, id);
  if (!sp) return invalid(c, 404, `Service principal '${id}' not found`);

  const body = (await readJsonBody(c)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return invalid(c, 400, "Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const scope =
    typeof b.scope === "string" && b.scope.trim() !== ""
      ? b.scope.trim()
      : "https://management.azure.com/.default";
  if (b.refresh !== undefined && typeof b.refresh !== "boolean") {
    return invalid(c, 400, "`refresh` must be a boolean");
  }

  const result = await getAccessToken(c.env, {
    tenantId: sp.tenantId,
    clientId: sp.clientId,
    clientSecret: sp.clientSecret,
    scope,
    refresh: b.refresh === true,
  });

  return c.json({
    ok: true,
    sp: id,
    scope,
    source: result.source,
    expiresAt: new Date(result.expiresAt).toISOString(),
    tokenMasked: maskSecret(result.token),
    authority: defaultAuthority(c.env),
  });
});

/** 失效令牌缓存 (L1 + L2); body 可选 { scope }, 省略则失效该 SP 全部 scope */
admin.delete("/sps/:id/token", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const sp = await getSpFromD1(c.env, id);
  if (!sp) return invalid(c, 404, `Service principal '${id}' not found`);

  const body = (await readJsonBody(c)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return invalid(c, 400, "Request body must be a JSON object");
  }
  const scope = (body as Record<string, unknown>).scope;
  if (scope !== undefined && typeof scope !== "string") {
    return invalid(c, 400, "`scope` must be a string");
  }

  if (typeof scope === "string" && scope.trim() !== "") {
    await evictToken(c.env, sp.tenantId, sp.clientId, scope.trim());
  } else {
    await evictSpTokens(c.env, sp.tenantId, sp.clientId);
  }
  return c.json({ ok: true, sp: id, evicted: true });
});

// ---------- ARM 管理面矩阵 (阶段二, 便捷端点 + 任意路径通用透传) ----------

admin.use("/arm", requireAdminToken);
admin.use("/arm/*", requireAdminToken);

const AV_SUBS = "2022-12-01";
const AV_RG = "2021-04-01";
const AV_COG = "2023-05-01";

async function loadArmSp(c: Context<{ Bindings: Env }>, id: string): Promise<SpRecord | null> {
  return getSpFromD1(c.env, id);
}

async function callArm(
  c: Context<{ Bindings: Env }>,
  sp: SpRecord,
  method: string,
  armPath: string,
  opts: Parameters<typeof armRequest>[4] = {}
) {
  try {
    const r = await armRequest(c.env, sp, method, armPath, opts);
    if (r.isJson) {
      return c.json(r.body, r.status as ContentfulStatusCode);
    }
    return new Response(r.body as string, { status: r.status });
  } catch (e) {
    if (e instanceof ArmError) {
      return c.json({ error: { message: e.message, type: "arm_error" } }, 502);
    }
    throw e; // TokenError 等由全局 onError 统一映射
  }
}

/** 列出该 SP 可访问的订阅 */
admin.get("/arm/:sp/subscriptions", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  return callArm(c, sp, "GET", "/subscriptions", { apiVersion: AV_SUBS });
});

/** 列出订阅下的资源组 */
admin.get("/arm/:sp/subscriptions/:sub/resourcegroups", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  const sub = encodeURIComponent(c.req.param("sub"));
  return callArm(c, sp, "GET", `/subscriptions/${sub}/resourcegroups`, { apiVersion: AV_RG });
});

/** 列出订阅下全部 OpenAI / Cognitive 账户 */
admin.get("/arm/:sp/subscriptions/:sub/accounts", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  const sub = encodeURIComponent(c.req.param("sub"));
  return callArm(c, sp, "GET", `/subscriptions/${sub}/providers/Microsoft.CognitiveServices/accounts`, {
    apiVersion: AV_COG,
  });
});

/** 列出资源组下的 OpenAI / Cognitive 账户 */
admin.get("/arm/:sp/subscriptions/:sub/resourceGroups/:rg/accounts", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  const sub = encodeURIComponent(c.req.param("sub"));
  const rg = encodeURIComponent(c.req.param("rg"));
  return callArm(
    c,
    sp,
    "GET",
    `/subscriptions/${sub}/resourcegroups/${rg}/providers/Microsoft.CognitiveServices/accounts`,
    { apiVersion: AV_COG }
  );
});

/** 列出账户下的模型部署 */
admin.get("/arm/:sp/subscriptions/:sub/resourceGroups/:rg/accounts/:account/deployments", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  const sub = encodeURIComponent(c.req.param("sub"));
  const rg = encodeURIComponent(c.req.param("rg"));
  const account = encodeURIComponent(c.req.param("account"));
  return callArm(
    c,
    sp,
    "GET",
    `/subscriptions/${sub}/resourcegroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${account}/deployments`,
    { apiVersion: AV_COG }
  );
});

/** 列出指定位置可用的模型 (面板创建部署时展示) */
admin.get("/arm/:sp/subscriptions/:sub/locations/:location/models", async (c) => {
  const sp = await loadArmSp(c, c.req.param("sp"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
  const sub = encodeURIComponent(c.req.param("sub"));
  const location = encodeURIComponent(c.req.param("location"));
  return callArm(
    c,
    sp,
    "GET",
    `/subscriptions/${sub}/providers/Microsoft.CognitiveServices/locations/${location}/models`,
    { apiVersion: AV_COG }
  );
});

/** 获取账户密钥 (用于把实例导入网关节点池; ADMIN_TOKEN 持有者已受信) */
admin.post(
  "/arm/:sp/subscriptions/:sub/resourceGroups/:rg/accounts/:account/listKeys",
  async (c) => {
    const sp = await loadArmSp(c, c.req.param("sp"));
    if (!sp) return invalid(c, 404, `Service principal '${c.req.param("sp")}' not found`);
    const sub = encodeURIComponent(c.req.param("sub"));
    const rg = encodeURIComponent(c.req.param("rg"));
    const account = encodeURIComponent(c.req.param("account"));
    return callArm(
      c,
      sp,
      "POST",
      `/subscriptions/${sub}/resourcegroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${account}/listKeys`,
      { apiVersion: AV_COG }
    );
  }
);

/**
 * 通用透传: 任意 ARM 路径/方法, 实现"全矩阵"覆盖。
 * 查询参数原样透传 (api-version 可显式指定, 缺省用 env.ARM_API_VERSION)。
 */
admin.all("/arm/:sp/*", async (c) => {
  const spId = c.req.param("sp");
  const sp = await loadArmSp(c, spId);
  if (!sp) return invalid(c, 404, `Service principal '${spId}' not found`);

  const url = new URL(c.req.url);
  const prefix = `/admin/arm/${spId}`;
  const armPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  if (armPath === "" || armPath === "/") {
    return invalid(c, 400, "ARM path is required after /admin/arm/:sp");
  }

  const method = c.req.method;
  const body = ["GET", "HEAD"].includes(method) ? undefined : await c.req.arrayBuffer();
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== "api-version") query[k] = v;
  });
  const apiVersion = url.searchParams.get("api-version") ?? undefined;

  return callArm(c, sp, method, armPath, {
    body,
    contentType: c.req.header("content-type"),
    query,
    apiVersion,
  });
});

// 元信息: 便于调试当前 ARM 配置
admin.get("/arm", (c) =>
  c.json({
    ok: true,
    armBaseUrl: defaultArmBase(c.env),
    armScope: armScope(c.env),
    defaultApiVersion: c.env.ARM_API_VERSION ?? "2023-05-01",
  })
);

// ---------- 网关 Key 管理 (Phase 3: D1 化 Key, 只存 SHA-256 摘要 + 配额/限流) ----------

admin.use("/keys", requireAdminToken);
admin.use("/keys/*", requireAdminToken);

function toPublicKey(rec: GatewayKeyRecord) {
  return {
    id: rec.id,
    keyMasked: `${rec.keyPrefix}***${rec.keySuffix}`,
    label: rec.label ?? null,
    enabled: rec.enabled,
    rateLimitPerMin: rec.rateLimitPerMin,
    dailyRequestQuota: rec.dailyRequestQuota,
    dailyTokenQuota: rec.dailyTokenQuota,
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
  };
}

/** 发放新 Key: 明文仅在创建响应中出现一次, 库里只有 SHA-256 摘要 */
admin.post("/keys", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const raw = await readJsonBody(c);
  if (raw === null) return invalid(c, 400, "Request body must be valid JSON");
  const parsed = validateKeyInput(raw);
  if (!parsed.ok) return invalid(c, 400, parsed.message);
  const { record, plaintext } = await createGatewayKey(c.env, parsed.value);
  return c.json({ ok: true, key: toPublicKey(record), plaintext }, 201);
});

admin.get("/keys", async (c) => {
  const recs = await listGatewayKeysFromD1(c.env);
  if (recs === null) return dbNotConfigured(c);
  return c.json({ ok: true, keys: recs.map(toPublicKey) });
});

/** 部分更新: label / enabled / 三项限额 (传 null 表示取消限制) */
admin.patch("/keys/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const raw = await readJsonBody(c);
  if (raw === null) return invalid(c, 400, "Request body must be valid JSON");
  const body = raw as Record<string, unknown>;
  const parsed = validateKeyInput(body, { partial: true });
  if (!parsed.ok) return invalid(c, 400, parsed.message);
  const patch: GatewayKeyInput & { enabled?: boolean } = { ...parsed.value };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return invalid(c, 400, "`enabled` must be a boolean");
    patch.enabled = body.enabled;
  }
  const updated = await updateGatewayKey(c.env, id, patch);
  if (!updated) return invalid(c, 404, `Gateway key '${id}' not found`);
  return c.json({ ok: true, key: toPublicKey(updated) });
});

admin.delete("/keys/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const ok = await deleteGatewayKeyFromD1(c.env, id);
  if (!ok) return invalid(c, 404, `Gateway key '${id}' not found`);
  return c.json({ ok: true, deleted: id });
});

// ---------- 用量统计 (Phase 3: request_logs / usage_daily 聚合查询) ----------

admin.use("/usage", requireAdminToken);
admin.use("/usage/*", requireAdminToken);

/** 汇总: ?days=7&key=<key_id> -> summary + byDay + byKey + byDeployment */
admin.get("/usage", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const daysRaw = Number(c.req.query("days") ?? "7");
  const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : 7;
  const keyId = c.req.query("key") || undefined;
  const result = await queryUsage(c.env, { days, keyId });
  return c.json({ ok: true, ...result, keyId: keyId ?? null });
});

/** 最近请求日志: ?limit=50&key=<key_id> */
admin.get("/usage/logs", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const keyId = c.req.query("key") || undefined;
  const logs = await queryUsageLogs(c.env, { limit, keyId });
  return c.json({ ok: true, logs });
});

/** 手动清理 N 天前的日志: ?days=7 */
admin.delete("/usage/logs", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const daysRaw = Number(c.req.query("days") ?? "7");
  const days = Number.isInteger(daysRaw) && daysRaw > 0 ? daysRaw : 7;
  const deleted = await purgeUsageLogs(c.env, days);
  return c.json({ ok: true, deleted, olderThanDays: days });
});

