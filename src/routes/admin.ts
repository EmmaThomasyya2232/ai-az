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
import {
  listBreakers,
  resetBreaker,
  breakerEnabled,
  breakerThreshold,
  breakerCooldownSec,
} from "../core/breaker";
import { runPatrol } from "../core/patrol";
import {
  parseSpPasteJson,
  slugIdFromDisplayName,
} from "../core/sp";
import {
  listSubsFromD1,
  getSubFromD1,
  upsertSub,
  patchSubState,
  deleteSubFromD1,
  syncSubscriptionsFromArm,
  isWarmupStatus,
  type SubRecord,
} from "../core/subs";
import { discoverAllowedRegions } from "../core/regions";
import {
  bootstrapWarmup,
  runDailyWarmup,
  fetchTierStatus,
  fetchUsageSnapshot,
} from "../core/warmup";
import {
  getSystemConfig,
  setSystemConfig,
  deleteSystemConfig,
  listSystemConfigs,
} from "../core/config-store";


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

// ---------- 熔断器与定时巡检 (阶段五) ----------

admin.use("/breakers", requireAdminToken);
admin.use("/breakers/*", requireAdminToken);
admin.use("/patrol", requireAdminToken);

/** 全部节点熔断状态 + 配置 */
admin.get("/breakers", async (c) => {
  const rows = await listBreakers(c.env);
  return c.json({
    ok: true,
    enabled: breakerEnabled(c.env),
    threshold: breakerThreshold(c.env),
    cooldownSec: breakerCooldownSec(c.env),
    breakers: rows,
  });
});

/** 手动复位节点熔断器 (回到 closed) */
admin.post("/breakers/:name/reset", async (c) => {
  const name = c.req.param("name");
  const existed = await resetBreaker(c.env, name);
  return c.json({ ok: true, name, existed });
});

/** 手动触发一次巡检 (探活/令牌预热/日志清理), 返回完整摘要 */
admin.post("/patrol", async (c) => {
  const summary = await runPatrol(c.env, "manual");
  return c.json({ ok: true, summary });
});

// ---------- 模块 1: 服务主体 JSON 粘贴录入 + 订阅自动发现 (阶段六) ----------

admin.use("/sps/import", requireAdminToken);

/** 一键粘贴 Azure CLI JSON: 验真 + 订阅穿透 + 入库 (亦暴露于 POST /api/service-principals) */
export const importServicePrincipalHandler: (c: Context<{ Bindings: Env }>) => Promise<Response> = async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const body = await readJsonBody(c);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid(c, 400, "Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const rawJson = typeof b.json === "string" ? b.json : "";
  const customId = typeof b.id === "string" ? b.id.trim() : "";
  const customLabel = typeof b.label === "string" ? b.label.trim() : "";

  const parsed = parseSpPasteJson(rawJson);
  if (!parsed.ok) return invalid(c, 400, parsed.message);

  // 验真: 拿一次管理令牌 (OAuth2 client_credentials), 失败则凭据无效
  const sp: SpRecord = {
    id: customId || slugIdFromDisplayName(parsed.input.displayName ?? ""),
    tenantId: parsed.input.tenantId,
    clientId: parsed.input.clientId,
    clientSecret: parsed.input.clientSecret,
    label: customLabel || parsed.input.displayName || undefined,
  };
  try {
    const t = await getAccessToken(c.env, {
      tenantId: sp.tenantId,
      clientId: sp.clientId,
      clientSecret: sp.clientSecret,
      scope: armScope(c.env),
    });
    if (!t.token) throw new Error("empty token");
  } catch (e) {
    return invalid(
      c,
      401,
      `凭据验证失败 (OAuth2): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 入库 (UPSERT, 幂等)
  await upsertSp(c.env, sp);
  // 订阅穿透: ARM /subscriptions 动态拉取并入库
  let subs: SubRecord[] = [];
  try {
    subs = await syncSubscriptionsFromArm(c.env, sp);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `订阅穿透失败: ${msg}`);
  }
  return c.json(
    {
      ok: true,
      sp: sp.id,
      label: sp.label ?? null,
      subsDiscovered: subs.map((s) => ({ id: s.id, name: s.name })),
      subCount: subs.length,
    },
    201
  );
};

admin.post("/sps/import", importServicePrincipalHandler);

// ---------- 订阅资产管理 (阶段六) ----------

admin.use("/subs", requireAdminToken);
admin.use("/subs/*", requireAdminToken);

function toSubPublic(s: SubRecord) {
  return s;
}

/** 列出全部已入库订阅画像 (亦暴露于 GET /api/subscriptions) */
export const listSubsHandler: (c: Context<{ Bindings: Env }>) => Promise<Response> = async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const list = (await listSubsFromD1(c.env)) ?? [];
  return c.json({ ok: true, count: list.length, subs: list.map(toSubPublic) });
};

admin.get("/subs", listSubsHandler);

/** 手动同步某服务主体的订阅 → 全量入库 */
admin.post("/subs/sync/:spId", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const sp = await getSpFromD1(c.env, c.req.param("spId"));
  if (!sp) return invalid(c, 404, `Service principal '${c.req.param("spId")}' not found`);
  try {
    const subs = await syncSubscriptionsFromArm(c.env, sp);
    return c.json({ ok: true, sp: sp.id, subCount: subs.length, subs: subs.map(toSubPublic) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `订阅穿透失败: ${msg}`);
  }
});

function parseAllowedRegions(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const arr: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && /^[a-z0-9-]+$/.test(x.trim())) arr.push(x.trim());
  }
  return arr;
}

/** 更新订阅画像 (名称 / 区域白名单 / 打卡状态手动覆盖) */
admin.patch("/subs/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const cur = await getSubFromD1(c.env, id);
  if (!cur) return invalid(c, 404, `Subscription '${id}' not found`);
  const body = await readJsonBody(c);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid(c, 400, "Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: Partial<SubRecord> = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.length > 256) {
      return invalid(c, 400, "`name` must be a string (max 256)");
    }
    patch.name = b.name.trim();
  }
  if (b.allowedRegions !== undefined) {
    const regions = parseAllowedRegions(b.allowedRegions);
    if (regions === undefined) return invalid(c, 400, "`allowedRegions` must be a string array or null");
    patch.allowedRegions = regions;
  }
  if (b.warmupStatus !== undefined) {
    if (!isWarmupStatus(b.warmupStatus)) {
      return invalid(c, 400, "`warmupStatus` must be Pending/Active/Upgraded/Disabled");
    }
    patch.warmupStatus = b.warmupStatus;
  }
  await upsertSub(c.env, { ...cur, ...patch });
  const updated = await getSubFromD1(c.env, id);
  return c.json({ ok: true, sub: updated ? toSubPublic(updated) : null });
});

/** 删除订阅画像 (不删除 Azure 资源, 仅移除本控制器记录) */
admin.delete("/subs/:id", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const existed = await deleteSubFromD1(c.env, id);
  if (!existed) return invalid(c, 404, `Subscription '${id}' not found`);
  return c.json({ ok: true, deleted: id });
});



// ---------- 模块 2&3: 区域白名单探测 + 一键上架 + 打卡 (阶段六) ----------

/** 探测订阅可用区域白名单 (策略解析 + 探针回退), 落库 */
admin.post("/subs/:id/probe", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const sub = await getSubFromD1(c.env, id);
  if (!sub) return invalid(c, 404, `Subscription '${id}' not found`);
  const sp = await getSpFromD1(c.env, sub.spId);
  if (!sp) return invalid(c, 404, `Service principal '${sub.spId}' not found`);
  try {
    const regions = await discoverAllowedRegions(c.env, sp, sub.id);
    await patchSubState(c.env, sub.id, { allowedRegions: regions ?? null });
    return c.json({
      ok: true,
      subscriptionId: id,
      allowedRegions: regions ?? [],
      discovered: (regions ?? []).length > 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `区域探测失败: ${msg}`);
  }
});

/** 读取订阅 Tier 状态 (QuotaTiers) */
admin.get("/subs/:id/tier", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const sub = await getSubFromD1(c.env, id);
  if (!sub) return invalid(c, 404, `Subscription '${id}' not found`);
  const sp = await getSpFromD1(c.env, sub.spId);
  if (!sp) return invalid(c, 404, `Service principal '${sub.spId}' not found`);
  try {
    const tier = await fetchTierStatus(c.env, sp, sub.id);
    if (tier) {
      await patchSubState(c.env, sub.id, {
        currentTier: tier.currentTierName ?? sub.currentTier,
        upgradeUnavailabilityReason: tier.upgradeUnavailabilityReason,
        lastTierCheckedAt: new Date().toISOString(),
      });
    }
    return c.json({ ok: true, subscriptionId: id, tier });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `Tier 读取失败: ${msg}`);
  }
});

/** 读取订阅指定区域配额水位 (CognitiveServices Usage) */
admin.get("/subs/:id/usage-snapshot", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  const sub = await getSubFromD1(c.env, id);
  if (!sub) return invalid(c, 404, `Subscription '${id}' not found`);
  const sp = await getSpFromD1(c.env, sub.spId);
  if (!sp) return invalid(c, 404, `Service principal '${sub.spId}' not found`);
  const location = c.req.query("location") || "centralus";
  try {
    const snap = await fetchUsageSnapshot(c.env, sp, sub.id, location);
    if (!snap) return invalid(c, 502, "配额水位读取失败 (检查区域/权限)");
    return c.json({ ok: true, subscriptionId: id, snapshot: snap });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `配额读取失败: ${msg}`);
  }
});

/** 一键安全上架 (safe-bootstrap): RG + AIServices + Embedding 部署 + 首发微调用 (亦暴露于 POST /api/subscriptions/:id/safe-bootstrap) */
export const bootstrapHandler: (c: Context<{ Bindings: Env }>) => Promise<Response> = async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const id = c.req.param("id");
  if (!id) return invalid(c, 400, "Missing subscription id");
  const sub = await getSubFromD1(c.env, id);
  if (!sub) return invalid(c, 404, `Subscription '${id}' not found`);
  const sp = await getSpFromD1(c.env, sub.spId);
  if (!sp) return invalid(c, 404, `Service principal '${sub.spId}' not found`);
  const body = (await readJsonBody(c)) as Record<string, unknown> | null;
  const pickMe = (k: string, max: number) => {
    const v = body?.[k];
    return typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : undefined;
  };
  const location = pickMe("location", 64);
  const model = pickMe("model", 128);
  try {
    const result = await bootstrapWarmup(c.env, sub, sp, { location, model });
    if (result.status === "failed") {
      return c.json({ ok: false, result }, 400);
    }
    return c.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(c, 502, `一键上架失败: ${msg}`);
  }
};

admin.post("/subs/:id/bootstrap", bootstrapHandler);

/** 手动触发一次每日打卡 (排障 / 验收用) */
admin.post("/warmup/run", async (c) => {
  const summary = await runDailyWarmup(c.env, "manual");
  return c.json({ ok: true, summary });
});

/** 每次打卡流水日志 */
admin.get("/warmup/logs", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const subId = c.req.query("sub") || undefined;
  try {
    let rows: Array<Record<string, unknown>>;
    if (subId) {
      rows = (
        await c.env.DB.prepare(
          `SELECT id, subscription_id, instance_name, model_name, tokens_consumed, status_code,
                  response_time_ms, result_status, error, created_at
           FROM warmup_logs WHERE subscription_id = ?1 ORDER BY created_at DESC LIMIT ?2`
        ).bind(subId, limit).all()
      ).results ?? [];
    } else {
      rows = (
        await c.env.DB.prepare(
          `SELECT id, subscription_id, instance_name, model_name, tokens_consumed, status_code,
                  response_time_ms, result_status, error, created_at
           FROM warmup_logs ORDER BY created_at DESC LIMIT ?1`
        ).bind(limit).all()
      ).results ?? [];
    }
    return c.json({ ok: true, logs: rows });
  } catch (e) {
    return invalid(c, 500, e instanceof Error ? e.message : String(e));
  }
});

// ---------- 系统配置 (阶段六: system_configs 动态覆盖 + 快速查看) ----------

admin.get("/config", async (c) => {
  const rows = await listSystemConfigs(c.env);
  return c.json({ ok: true, configs: rows });
});

admin.put("/config/:key", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const key = c.req.param("key");
  if (!/^[a-z0-9_.-]+$/.test(key)) return invalid(c, 400, "Invalid config key");
  const body = await readJsonBody(c);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid(c, 400, "Request body must be a JSON object");
  }
  const value = (body as Record<string, unknown>).value;
  if (typeof value !== "string") return invalid(c, 400, "`value` must be a string");
  await setSystemConfig(c.env, key, value);
  const updated = await getSystemConfig(c.env, key);
  return c.json({ ok: true, key, value: updated });
});

admin.delete("/config/:key", async (c) => {
  if (!c.env.DB) return dbNotConfigured(c);
  const key = c.req.param("key");
  if (!/^[a-z0-9_.-]+$/.test(key)) return invalid(c, 400, "Invalid config key");
  const deleted = await deleteSystemConfig(c.env, key);
  return c.json({ ok: true, key, deleted });
});
