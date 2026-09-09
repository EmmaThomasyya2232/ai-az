import type { Context, Next } from "hono";
import type { Env } from "../types";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 网关鉴权: Authorization: Bearer sk-az-xxx 或 x-api-key。
 * 使用 SHA-256 摘要比较, 避免时序侧信道。
 */
export async function requireGatewayKey(c: Context<{ Bindings: Env }>, next: Next) {
  const configured = (c.env.GATEWAY_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return c.json(
      { error: { message: "Gateway is not configured: GATEWAY_KEYS is empty", type: "config_error" } },
      500
    );
  }

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

  const providedHash = await sha256Hex(provided);
  for (const key of configured) {
    if (providedHash === (await sha256Hex(key))) {
      await next();
      return;
    }
  }

  return c.json(
    { error: { message: "Invalid API key", type: "auth_error", code: "invalid_api_key" } },
    401
  );
}
