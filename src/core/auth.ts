import type { Context, Next } from "hono";
import type { Env } from "../types";
import { sha256Hex } from "./crypto";
import {
  resolveGatewayKey,
  hasD1GatewayKeys,
  envGatewayKeysConfigured,
  type ResolvedGatewayKey,
} from "./gateway-keys";

/**
 * Admin API 鉴权: Authorization: Bearer <ADMIN_TOKEN>。
 * 与网关 Key 相同, 使用 SHA-256 摘要比较, 避免时序侧信道。
 */
export async function requireAdminToken(c: Context<{ Bindings: Env }>, next: Next) {
  const expected = (c.env.ADMIN_TOKEN ?? "").trim();
  if (expected === "") {
    return c.json(
      { error: { message: "Admin API is not configured: ADMIN_TOKEN is empty", type: "config_error" } },
      500
    );
  }

  const auth = c.req.header("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided) {
    return c.json(
      { error: { message: "Missing admin token", type: "auth_error", code: "missing_admin_token" } },
      401
    );
  }

  if ((await sha256Hex(provided)) !== (await sha256Hex(expected))) {
    return c.json(
      { error: { message: "Invalid admin token", type: "auth_error", code: "invalid_admin_token" } },
      401
    );
  }

  await next();
}

export type { ResolvedGatewayKey };

/**
 * 网关鉴权: Authorization: Bearer sk-az-xxx 或 x-api-key。
 * 阶段三: 先查 D1 gateway_keys (摘要精确命中), 未命中回落 GATEWAY_KEYS 环境变量;
 * 解析结果挂到 c.set("gwKey") 供限流/配额与用量归因使用。
 */
export async function requireGatewayKey(
  c: Context<{ Bindings: Env; Variables: { gwKey: ResolvedGatewayKey } }>,
  next: Next
) {
  const auth = c.req.header("authorization") ?? "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : (c.req.header("x-api-key") ?? "").trim();

  if (!provided) {
    return c.json(
      { error: { message: "Missing API key", type: "auth_error", code: "missing_api_key" } },
      401
    );
  }

  const resolved = await resolveGatewayKey(c.env, provided);
  if (resolved) {
    c.set("gwKey", resolved);
    await next();
    return;
  }

  // 区分 "网关根本没配置 Key" (500) 与 "Key 无效" (401), 保持阶段一错误形状
  const configured = envGatewayKeysConfigured(c.env) || (await hasD1GatewayKeys(c.env));
  if (!configured) {
    return c.json(
      { error: { message: "Gateway is not configured: GATEWAY_KEYS is empty", type: "config_error" } },
      500
    );
  }

  return c.json(
    { error: { message: "Invalid API key", type: "auth_error", code: "invalid_api_key" } },
    401
  );
}

