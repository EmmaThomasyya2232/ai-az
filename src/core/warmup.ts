import type { Env } from "../types";
import type { SpRecord } from "./sp";
import type { SubRecord } from "./subs";
import { getSpFromD1 } from "./sp";
import { armRequest } from "./arm";
import { bestRegion, parseAllowedFromError, extractArmErrorMessage } from "./regions";
import {
  listSubsFromD1,
  patchSubState,
} from "./subs";
import { sendAlert } from "./notify";
import { getSystemConfig } from "./config-store";
import { sha256Hex } from "./crypto";

/**
 * 阶段六: 养号打卡与提档引擎 (Automated Warmup)。
 *   - safe-bootstrap: 一键上架流水线 (RG + AIServices S0 + Embedding 部署 + 首发微调用)
 *   - runDailyWarmup: Cron 每日微量打卡 + QuotaTiers 提档检测 + 停止打卡 + Webhook 推送
 */

const AV_COG = "2023-05-01";
const AV_RG = "2021-04-01";
const AV_QUOTA_TIERS = "2025-03-01";
const AV_USAGE = "2023-05-01";
const ARM_TIMEOUT_MS = 45_000;

export const WARMUP_RG = "azmgr-warmup";
export const WARMUP_MODEL_DEFAULT = "text-embedding-3-small";

// ---------- 配置读取 (env 优先, 其次 system_configs 动态覆盖) ----------

export function warmupDefaultRegion(env: Env): string {
  return env.WARMUP_DEFAULT_REGION ?? "centralus";
}

export function warmupSkuName(env: Env): string {
  return env.WARMUP_SKU_NAME ?? "S0";
}

export function warmupMaxTokens(env: Env): number {
  const n = Math.floor(Number(env.WARMUP_MAX_TOKENS ?? "32"));
  return Number.isFinite(n) && n > 0 ? n : 32;
}

export async function warmupEnabled(env: Env, db: boolean): Promise<boolean> {
  if (!db) return false;
  const cfg = await getSystemConfig(env, "warmup_enabled");
  if (cfg === "off") return false;
  if (cfg === "on") return true;
  return env.CRON_WARMUP !== "off";
}

export async function effectiveModel(env: Env): Promise<string> {
  const cfg = await getSystemConfig(env, "warmup_model");
  if (cfg) return cfg;
  return env.WARMUP_MODEL ?? WARMUP_MODEL_DEFAULT;
}

export async function effectiveDefaultRegion(env: Env): Promise<string> {
  const cfg = await getSystemConfig(env, "warmup_default_region");
  if (cfg) return cfg;
  return warmupDefaultRegion(env);
}

export async function effectiveWebhookUrl(env: Env): Promise<string | undefined> {
  const cfg = await getSystemConfig(env, "alert_webhook_url");
  return (cfg ?? env.ALERT_WEBHOOK_URL) || undefined;
}

// ---------- 数据面 helpers ----------

interface KeyResp {
  key1?: unknown;
  primaryKey?: unknown;
}

interface AccountResp {
  properties?: { endpoint?: unknown; provisioningState?: unknown };
  location?: unknown;
}

function uuid(): string {
  return crypto.randomUUID();
}

/** AIServices 账户名: azmgrwu + 订阅 ID 前 6 位十六进制 (16 hex => 稳定且唯一) */
async function accountNameFor(subId: string): Promise<string> {
  const hash = await sha256Hex(subId);
  return `azmgrwu-${hash.slice(0, 12)}`;
}

async function dataBody(obj: unknown): Promise<Uint8Array> {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** 打卡日志写入 warmup_logs (失败仅告警, 不阻塞主流程) */
export async function logWarmupCall(
  env: Env,
  entry: {
    subscriptionId: string;
    instanceName: string;
    modelName: string;
    tokensConsumed: number;
    statusCode: number | null;
    responseTimeMs: number | null;
    resultStatus: "Success" | "Failed";
    error?: string | null;
  }
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO warmup_logs
         (id, subscription_id, instance_name, model_name, tokens_consumed, status_code,
          response_time_ms, result_status, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        uuid(),
        entry.subscriptionId,
        entry.instanceName,
        entry.modelName,
        entry.tokensConsumed,
        entry.statusCode,
        entry.responseTimeMs,
        entry.resultStatus,
        entry.error ?? null
      )
      .run();
  } catch (e) {
    console.warn("warmup log write failed:", e instanceof Error ? e.message : e);
  }
}

/** 规格名称可读化: S0 / F0 */
export function humanSku(sku: string): string {
  return /^(?:S|F|T|E|P)[0-9]+$/i.test(sku) ? sku.toUpperCase() : sku;
}

// ---------- 一键安全上架流水线 (safe-bootstrap) ----------

export interface BootstrapResult {
  status: "provisioned" | "failed";
  accountName: string;
  resourceGroup: string;
  location: string;
  model: string;
  message: string;
}

interface CogAccountBody extends AccountResp {
  kind?: unknown;
  sku?: { name?: unknown };
  id?: unknown;
  name?: unknown;
}

/** 区域被策略拒绝时的回退处理: 解析错误文本 -> 修正白名单 -> 换区重试 (最多 2 次) */
async function regionFallbackOrFail(
  env: Env,
  sub: SubRecord,
  sp: SpRecord,
  opts: { location?: string; model?: string; retryDepth?: number },
  failedLocation: string,
  model: string,
  res: { status: number; body: unknown },
  baseMessage: string
): Promise<BootstrapResult> {
  const errText = extractArmErrorMessage(res.body);
  const candidates = parseAllowedFromError(errText).filter((r) => r !== failedLocation);
  const depth = opts.retryDepth ?? 0;
  if (candidates.length > 0 && depth < 2) {
    const nextLocation = candidates[0];
    // 修正订阅白名单 (真实允许区域), 前端级联下拉随之更新
    await patchSubState(env, sub.id, { allowedRegions: candidates });
    const retry = await bootstrapWarmup(env, { ...sub, allowedRegions: candidates }, sp, {
      model,
      location: nextLocation,
      retryDepth: depth + 1,
    });
    return {
      ...retry,
      message: `区域 '${failedLocation}' 被策略拒绝, 已切换到 '${nextLocation}' 重试 → ${retry.message}`,
    };
  }
  return {
    status: "failed",
    accountName: "",
    resourceGroup: WARMUP_RG,
    location: failedLocation,
    model,
    message: `${baseMessage}: ${errText.slice(0, 220) || "无错误详情"}`,
  };
}

/**
 * 一键上架流水线:
 *   1. 创建/复用资源组 (bestRegion)
 *   2. 创建 S0 规格 AIServices 实例
 *   3. 部署 text-embedding-3-small (优先 GlobalStandard, 失败回退 Standard)
 *   4. 首发 2-token embedding 调用 (留下非零 Metrics), 并入库 warmup_logs
 *   5. 标记 warmup_target / warmup_status = Active
 * 区域被策略拒绝 (RequestDisallowedByAzure) 时: 从错误文本反向解析允许区域,
 * 修正订阅白名单并自动换区重试 (最多 2 次)。
 */
export async function bootstrapWarmup(
  env: Env,
  sub: SubRecord,
  sp: SpRecord,
  opts: { location?: string; model?: string; retryDepth?: number } = {}
): Promise<BootstrapResult> {
  const model = opts.model?.trim() || (await effectiveModel(env));
  const location = opts.location?.trim() || bestRegion(sub.allowedRegions, await effectiveDefaultRegion(env));
  if (!/^[a-z0-9-]+$/.test(location)) {
    return {
      status: "failed",
      accountName: "",
      resourceGroup: WARMUP_RG,
      location,
      model,
      message: `非法区域: ${location}`,
    };
  }

  const rg = WARMUP_RG;
  const accountName = await accountNameFor(sub.id);
  const deploymentName = `dep-${model.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40)}`;
  const basePath = `/subscriptions/${encodeURIComponent(sub.id)}/resourcegroups/${rg}`;
  const accountPath = `${basePath}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;

  // 1. 资源组 (存在则复用, 409 视为已存在)
  const rgBody = await dataBody({ location });
  const rgRes = await armRequest(env, sp, "PUT", `${basePath}`, {
    apiVersion: AV_RG,
    body: rgBody,
    contentType: "application/json",
  });
  if (rgRes.status !== 200 && rgRes.status !== 201 && rgRes.status !== 409) {
    return await regionFallbackOrFail(
      env, sub, sp, opts, location, model,
      rgRes, `创建资源组失败 (HTTP ${rgRes.status})`
    );
  }

  // 2. AIServices 账户 (已存在则跳过创建, 继续部署)
  const skuName = warmupSkuName(env);
  const acctBody = await dataBody({
    location,
    kind: "AIServices",
    sku: { name: skuName, tier: skuName.startsWith("S") ? "Standard" : "Free" },
    properties: {},
  });
  const acctRes = await armRequest(env, sp, "PUT", accountPath, {
    apiVersion: AV_COG,
    body: acctBody,
    contentType: "application/json",
  });
  if (acctRes.status !== 200 && acctRes.status !== 201 && acctRes.status !== 409) {
    return await regionFallbackOrFail(
      env, sub, sp, opts, location, model,
      acctRes, `创建 AIServices 账户失败 (HTTP ${acctRes.status})`
    );
  }

  // 3. 部署 embedding 模型: 优先 GlobalStandard, 失败回退 Standard
  const deploymentPath = `${accountPath}/deployments/${deploymentName}`;
  let deployRes = await armRequest(env, sp, "PUT", deploymentPath, {
    apiVersion: AV_COG,
    body: await dataBody({
      model: { format: "OpenAI", name: model, version: "1" },
      scaleSettings: { scaleType: "GlobalStandard" },
      raiPolice: {},
    }),
    contentType: "application/json",
  });
  if (deployRes.status >= 400 && deployRes.status < 500) {
    deployRes = await armRequest(env, sp, "PUT", deploymentPath, {
      apiVersion: AV_COG,
      body: await dataBody({
        model: { format: "OpenAI", name: model, version: "1" },
        scaleSettings: { scaleType: "Standard" },
        raiPolice: {},
      }),
      contentType: "application/json",
    });
  }
  if (deployRes.status !== 200 && deployRes.status !== 201) {
    const deployErr = extractArmErrorMessage(deployRes.body);
    return {
      status: "failed",
      accountName,
      resourceGroup: rg,
      location,
      model,
      message: `部署模型失败 (HTTP ${deployRes.status}): ${deployErr.slice(0, 220) || "无错误详情"}`,
    };
  }

  // 4. 首发 2-token 微调用 (健康检查), 记录 warmup_logs
  let endpoint = "";
  try {
    const acct = await armRequest(env, sp, "GET", accountPath, { apiVersion: AV_COG });
    const body = acct.body as CogAccountBody | null;
    endpoint = typeof body?.properties?.endpoint === "string" ? body.properties.endpoint : "";
  } catch {
    endpoint = "";
  }
  let key = "";
  try {
    const keys = await armRequest(env, sp, "POST", `${accountPath}/listKeys`, { apiVersion: AV_COG });
    const kb = keys.body as KeyResp | null;
    key = typeof kb?.key1 === "string" ? kb.key1 : typeof kb?.primaryKey === "string" ? kb.primaryKey : "";
  } catch {
    key = "";
  }

  let bootStatus: "Success" | "Failed" = "Failed";
  let statusCode: number | null = null;
  const started = Date.now();
  if (endpoint && key) {
    try {
      const resp = await fetch(
        `${endpoint}/openai/deployments/${encodeURIComponent(deploymentName)}/embeddings?api-version=${env.AZURE_API_VERSION ?? "2024-10-21"}`,
        {
          method: "POST",
          headers: { "api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ input: ["health check"], model }),
          signal: AbortSignal.timeout(ARM_TIMEOUT_MS),
        }
      );
      statusCode = resp.status;
      if (resp.ok) bootStatus = "Success";
    } catch (e) {
      console.warn("bootstrap model call failed:", e instanceof Error ? e.message : e);
    }
  }
  void logWarmupCall(env, {
    subscriptionId: sub.id,
    instanceName: accountName,
    modelName: model,
    tokensConsumed: 2,
    statusCode,
    responseTimeMs: Date.now() - started,
    resultStatus: bootStatus,
    error: bootStatus === "Success" ? null : (endpoint && key ? "首次调用未成功" : "缺少 endpoint/key"),
  });

  // 5. 标记上架
  await patchSubState(env, sub.id, {
    warmupTarget: true,
    warmupStatus: "Active",
    allowedRegions: sub.allowedRegions ?? null,
  });

  return {
    status: "provisioned",
    accountName,
    resourceGroup: rg,
    location,
    model,
    message: bootStatus === "Success" ? "资源就绪并通过健康检查" : "资源就绪, 但首次调用未成功",
  };
}

// ---------- Tier 与配额检测 ----------

export interface TierStatus {
  currentTierName: string | null;
  assignedTime: string | null;
  tierUpgradePolicy: unknown;
  upgradeUnavailabilityReason: string | null;
}

interface QuotaTierFields {
  currentTierName?: unknown;
  assignedTime?: unknown;
  tierUpgradePolicy?: unknown;
  upgradeUnavailabilityReason?: unknown;
}

/**
 * 真实 Azure 的 quotaTiers 响应字段可能位于:
 *   - 顶层 (老版本/mock)      { currentTierName, ... }
 *   - properties 嵌套 (标准)  { properties: { currentTierName, ... } }
 *   - value 数组 (列表形式)   { value: [ { properties: {...} } ] }
 * 统一在此归一化。
 */
function pickTierFields(body: unknown): QuotaTierFields {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.value) && b.value.length > 0) {
    const first = b.value[0] as Record<string, unknown> | undefined;
    return ((first?.properties ?? first ?? {}) as QuotaTierFields) ?? {};
  }
  const props = b.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    return props as QuotaTierFields;
  }
  return b as QuotaTierFields;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** 读取 CognitiveServices QuotaTiers (提档感知); api-version 可经 TIER_API_VERSION 覆盖 */
export async function fetchTierStatus(
  env: Env,
  sp: SpRecord,
  subscriptionId: string
): Promise<TierStatus | null> {
  try {
    const r = await armRequest(
      env,
      sp,
      "GET",
      `/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/quotaTiers/default`,
      { apiVersion: env.TIER_API_VERSION ?? AV_QUOTA_TIERS }
    );
    if (!r.isJson || r.status >= 300) return null;
    const f = pickTierFields(r.body);
    return {
      currentTierName: strOrNull(f.currentTierName),
      assignedTime: strOrNull(f.assignedTime),
      tierUpgradePolicy: f.tierUpgradePolicy ?? null,
      upgradeUnavailabilityReason: strOrNull(f.upgradeUnavailabilityReason),
    };
  } catch (e) {
    console.warn("tier detection failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface UsageItem {
  name: string | null;
  currentValue: number | null;
  limit: number | null;
  unit: string | null;
}

export interface UsageSnapshot {
  location: string;
  items: UsageItem[];
}

interface UsageResp {
  value?: Array<{
    name?: { value?: unknown };
    currentValue?: unknown;
    limit?: unknown;
    unit?: unknown;
  }>;
}

/** 读取指定区域的 CognitiveServices 配额水位 (TPM/RPM 等) */
export async function fetchUsageSnapshot(
  env: Env,
  sp: SpRecord,
  subscriptionId: string,
  location: string
): Promise<UsageSnapshot | null> {
  try {
    const r = await armRequest(
      env,
      sp,
      "GET",
      `/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/locations/${location}/usages`,
      { apiVersion: AV_USAGE }
    );
    if (!r.isJson || r.status >= 300) return null;
    const b = r.body as UsageResp | null;
    const items: UsageItem[] = (b?.value ?? []).map((u) => ({
      name: typeof u.name?.value === "string" ? u.name.value : null,
      currentValue: typeof u.currentValue === "number" ? u.currentValue : null,
      limit: typeof u.limit === "number" ? u.limit : null,
      unit: typeof u.unit === "string" ? u.unit : null,
    }));
    return { location, items };
  } catch (e) {
    console.warn("usage snapshot failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 判断当前 Tier 是否仍为 Free Tier (未提档) */
export function isFreeTier(tier: string | null): boolean {
  if (!tier) return true;
  return /free/i.test(tier) || /^(?:f0|free)$/i.test(tier.trim());
}

// ---------- 每日打卡 ----------

export interface WarmupRunSummary {
  trigger: string;
  startedAt: string;
  durationMs: number;
  enabled: boolean;
  checked: number;
  ok: number;
  failures: number;
  upgraded: string[];
  skipped: number;
}

export interface WarmupTickResult {
  ok: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
}

/** 对单个订阅执行一次微量打卡 (2-token embedding) */
async function tickWarmupTarget(
  env: Env,
  sp: SpRecord,
  sub: SubRecord
): Promise<WarmupTickResult> {
  const model = await effectiveModel(env);
  const accountName = await accountNameFor(sub.id);
  const accountPath = `/subscriptions/${encodeURIComponent(sub.id)}/resourcegroups/${WARMUP_RG}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;
  const deploymentName = `dep-${model.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40)}`;

  let endpoint = "";
  let key = "";
  try {
    const acct = await armRequest(env, sp, "GET", accountPath, { apiVersion: AV_COG });
    const body = acct.body as CogAccountBody | null;
    endpoint = typeof body?.properties?.endpoint === "string" ? body.properties.endpoint : "";
  } catch {
    endpoint = "";
  }
  try {
    const keys = await armRequest(env, sp, "POST", `${accountPath}/listKeys`, { apiVersion: AV_COG });
    const kb = keys.body as KeyResp | null;
    key = typeof kb?.key1 === "string" ? kb.key1 : typeof kb?.primaryKey === "string" ? kb.primaryKey : "";
  } catch {
    key = "";
  }

  const started = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  if (endpoint && key) {
    try {
      const resp = await fetch(
        `${endpoint}/openai/deployments/${encodeURIComponent(deploymentName)}/embeddings?api-version=${env.AZURE_API_VERSION ?? "2024-10-21"}`,
        {
          method: "POST",
          headers: { "api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ input: ["health check"], model }),
          signal: AbortSignal.timeout(ARM_TIMEOUT_MS),
        }
      );
      statusCode = resp.status;
      if (!resp.ok) error = `HTTP ${resp.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  } else {
    error = "missing endpoint/key (账户未就绪?)";
  }
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;

  await logWarmupCall(env, {
    subscriptionId: sub.id,
    instanceName: accountName,
    modelName: model,
    tokensConsumed: 2,
    statusCode,
    responseTimeMs: Date.now() - started,
    resultStatus: ok ? "Success" : "Failed",
    error,
  });
  return { ok, statusCode, responseTimeMs: Date.now() - started, error };
}

/** 提档后通过通知通道推送 (Telegram/飞书经转 Webhook URL) */
async function announceUpgrade(env: Env, sub: SubRecord, tier: string): Promise<void> {
  const url = await effectiveWebhookUrl(env);
  if (!url) return;
  await sendAlert(
    env,
    {
      event: "subscription.tier_upgraded",
      level: "info",
      title: "🎉 订阅提档成功",
      message: `订阅『${sub.name || sub.id}』已从 Free Tier 升级为 ${tier}, 养号任务已停止`,
      details: { subscriptionId: sub.id, tier },
    },
    { webhookUrl: url }
  );
}

/**
 * Cron 每日打卡 (含提档扫描):
 *   - 仅处理 warmup_status = Active 的订阅
 *   - 先拉 QuotaTiers: 已脱离 Free Tier 则标记 Upgraded、推送通知、不再打卡
 *   - 否则发送 2-token embedding 请求并计入 warmup_logs
 * 本地测试: curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
 */
export async function runDailyWarmup(env: Env, trigger: string): Promise<WarmupRunSummary> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const enabled = await warmupEnabled(env, !!env.DB);
  const summary: WarmupRunSummary = {
    trigger,
    startedAt,
    durationMs: 0,
    enabled,
    checked: 0,
    ok: 0,
    failures: 0,
    upgraded: [],
    skipped: 0,
  };
  if (!enabled) return { ...summary, durationMs: Date.now() - started };

  const subs = (await listSubsFromD1(env)) ?? [];
  for (const sub of subs) {
    if (sub.warmupStatus !== "Active") {
      if (sub.warmupStatus === "Upgraded") summary.skipped++;
      continue;
    }
    summary.checked++;

    const sp = await getSpFromD1(env, sub.spId);
    if (!sp) {
      summary.failures++;
      continue;
    }

    // 1. Tier 检测 (提档感知)
    const tier = await fetchTierStatus(env, sp, sub.id);
    if (tier && tier.currentTierName !== null) {
      await patchSubState(env, sub.id, {
        currentTier: tier.currentTierName,
        upgradeUnavailabilityReason: tier.upgradeUnavailabilityReason,
        lastTierCheckedAt: new Date().toISOString(),
      });
      if (!isFreeTier(tier.currentTierName)) {
        await patchSubState(env, sub.id, { warmupStatus: "Upgraded" });
        summary.upgraded.push(sub.id);
        await announceUpgrade(env, sub, tier.currentTierName);
        continue; // 已提档, 不再打卡
      }
    }

    // 2. 微量打卡
    const tick = await tickWarmupTarget(env, sp, sub);
    if (tick.ok) {
      summary.ok++;
    } else {
      summary.failures++;
      void sendAlert(env, {
        event: "warmup.tick_failed",
        level: "warn",
        title: "养号打卡失败",
        message: `订阅『${sub.name || sub.id}』打卡失败: ${tick.error ?? "unknown"} (HTTP ${tick.statusCode ?? "-"})`,
        details: { subscriptionId: sub.id, error: tick.error, statusCode: tick.statusCode },
      });
    }
  }

  summary.durationMs = Date.now() - started;
  return summary;
}
