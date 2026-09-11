import type { Env } from "../types";
import type { SpRecord } from "./sp";
import { armRequest } from "./arm";

/**
 * 阶段六: 区域白名单动态探测引擎。
 * 目标: 杜绝盲选区域部署触发 RequestDisallowedByAzure 策略拦截。
 *   1. 策略解析: policyAssignments -> policyDefinitions 中 listOfAllowedLocations 白名单;
 *   2. 探针回退: 若策略未显式枚举, 试探创建最小资源组, 从错误文本提取候选区域。
 * 探测结果落库到 azure_subscriptions.allowed_regions, 前端下拉框仅展示白名单区域。
 */

const AV_POLICY_ASSIGN = "2022-06-01";
const AV_POLICY_DEF = "2021-06-01";
const AV_RG = "2021-04-01";

/** 常见区域候选 (探针回退时按顺序试探) */
export const CANDIDATE_REGIONS = [
  "centralus",
  "canadacentral",
  "eastus2",
  "eastus",
  "westus2",
  "westus3",
  "northeurope",
  "westeurope",
  "southeastasia",
  "eastasia",
  "japaneast",
  "uksouth",
  "francecentral",
  "southcentralus",
  "northcentralus",
  "australiaeast",
  "brazilsouth",
] as const;

function unique(v: string[]): string[] {
  return [...new Set(v)];
}

function normalizeRegion(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, "");
  return /^[a-z0-9-]+$/.test(s) ? s : null;
}

interface AssignmentParameters {
  [key: string]: { value?: unknown } | undefined;
}
interface PolicyAssignment {
  name?: string;
  properties?: {
    policyDefinitionId?: string;
    parameters?: AssignmentParameters;
  };
}
interface PolicyDefinition {
  properties?: { parameters?: { [key: string]: { allowedValues?: unknown } | undefined } };
}

function pickLocations(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeRegion(v);
    if (n) out.push(n);
  }
  return unique(out);
}

/** 从单个 policyDefinition 解析 listOfAllowedLocations 白名单 */
async function parseLocationFromDefinition(
  env: Env,
  sp: SpRecord,
  definitionId: string
): Promise<string[]> {
  const name = definitionId.split("/").pop() ?? "";
  if (!name) return [];
  try {
    const r = await armRequest(
      env,
      sp,
      "GET",
      `/providers/Microsoft.Authorization/policyDefinitions/${name}`,
      { apiVersion: AV_POLICY_DEF }
    );
    if (!r.isJson || r.status >= 300) return [];
    const body = r.body as PolicyDefinition;
    const allowed = body.properties?.parameters?.listOfAllowedLocations?.allowedValues;
    return Array.isArray(allowed) ? pickLocations(allowed as unknown[]) : [];
  } catch (e) {
    console.warn("policy definition lookup failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** 1) 策略解析: 遍历 policyAssignments 收集白名单区域 */
export async function allowedFromPolicy(
  env: Env,
  sp: SpRecord,
  subscriptionId: string
): Promise<string[]> {
  try {
    const r = await armRequest(
      env,
      sp,
      "GET",
      `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments`,
      { apiVersion: AV_POLICY_ASSIGN }
    );
    if (!r.isJson || r.status >= 300) return [];
    const body = r.body as { value?: PolicyAssignment[] };
    const found: string[] = [];
    for (const assignment of body.value ?? []) {
      for (const param of Object.values(assignment.properties?.parameters ?? {})) {
        if (param && Array.isArray(param.value)) {
          found.push(...pickLocations(param.value as unknown[]));
        }
      }
      if (assignment.properties?.policyDefinitionId) {
        found.push(...(await parseLocationFromDefinition(env, sp, assignment.properties.policyDefinitionId)));
      }
    }
    return unique(found);
  } catch (e) {
    console.warn("policy assignments discovery failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
/** 从策略错误文本提取候选区域 (探针回退) */
export function parseAllowedFromError(text: string): string[] {
  const merged = text || "";
  const patterns: RegExp[] = [
    // "Allowed locations: 'centralus, etc'"
    /(?:listOfAllowedLocations|allowed\s+locations?|available\s+regions?)\s*[:：=]\s*'?([a-zA-Z0-9,\s\-]+?)'?/i,
    // "[centralus, canadacentral]" 数组形式
    /\[\s*([a-zA-Z0-9,\s\-]+)\s*\]/gi,
  ];
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of merged.matchAll(re)) {
      const chunk = m[1] ?? "";
      for (const part of chunk.split(/[,\s]+/)) {
        const n = normalizeRegion(part);
        if (n && n !== "allowed" && n !== "locations" && n !== "location") out.push(n);
      }
    }
  }
  return unique(out);
}

function extractErrorMessage(r: { body: unknown }): string {
  if (r.body && typeof r.body === "object") {
    const b = r.body as { error?: { message?: unknown } };
    if (typeof b.error?.message === "string") return b.error.message;
    const m = (r.body as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return typeof r.body === "string" ? r.body : "";
}

/**
 * 2) 探针回退: 对候选区域试探创建最小资源组 (成功后立即删除)。
 *    返回探测成功或从错误文本解析出的候选区域集合; 全部失败返回 []。
 */
export async function probeRegions(
  env: Env,
  sp: SpRecord,
  subscriptionId: string
): Promise<string[]> {
  const success: string[] = [];
  const fromErrors: string[] = [];

  const attemptOne = async (location: string) => {
    const rg = `azmgr-probe-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const path = `/subscriptions/${subscriptionId}/resourcegroups/${rg}`;
    try {
      const r = await armRequest(env, sp, "PUT", path, {
        apiVersion: AV_RG,
        body: new TextEncoder().encode(JSON.stringify({ location })),
        contentType: "application/json",
      });
      if (r.status >= 200 && r.status < 300) {
        success.push(location);
        // 试探资源组异步清理, 失败不阻塞
        void armRequest(env, sp, "DELETE", path, { apiVersion: AV_RG }).catch(() => {});
      } else {
        fromErrors.push(...parseAllowedFromError(extractErrorMessage(r)));
      }
    } catch (e) {
      console.warn(`region probe '${location}' failed:`, e instanceof Error ? e.message : e);
    }
  };

  // 分批并发 (每批 4 个), 避免触发流控与过度并发
  const batchSize = 4;
  for (let i = 0; i < CANDIDATE_REGIONS.length; i += batchSize) {
    const batch = CANDIDATE_REGIONS.slice(i, i + batchSize);
    await Promise.all(batch.map(attemptOne));
  }
  return unique([...success, ...fromErrors]);
}

/**
 * 订阅区域可用性画像入口。
 * 优先策略解析, 其次探针回退; 两者皆空返回 null (无法判定, 调用方使用默认区域)。
 */
export async function discoverAllowedRegions(
  env: Env,
  sp: SpRecord,
  subscriptionId: string
): Promise<string[] | null> {
  const fromPolicy = await allowedFromPolicy(env, sp, subscriptionId);
  if (fromPolicy.length > 0) return fromPolicy;
  const probed = await probeRegions(env, sp, subscriptionId);
  return probed.length > 0 ? probed : null;
}

/** 从白名单中选择最优合规区域 (优先常用区域, 其次白名单首个) */
export function bestRegion(allowed: string[] | null | undefined, fallback: string): string {
  if (!allowed || allowed.length === 0) return fallback;
  const preferred = ["centralus", "eastus2", "westus2", "canadacentral"];
  for (const p of preferred) {
    if (allowed.includes(p)) return p;
  }
  return allowed[0];
}