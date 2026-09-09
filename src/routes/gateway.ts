import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import { loadNodes, defaultApiVersion, requestTimeoutMs, isTransientStatus } from "../core/config";
import { Balancer } from "../core/balancer";
import { requireGatewayKey } from "../core/auth";

const MAX_ATTEMPTS = 3;

/** JSON 请求体路由 -> Azure 数据面路径 */
const JSON_ROUTES: Record<string, string> = {
  "/chat/completions": "/chat/completions",
  "/completions": "/completions",
  "/embeddings": "/embeddings",
  "/images/generations": "/images/generations",
  "/audio/speech": "/audio/speech",
};

/** multipart/form-data 请求体路由 (音频转写/翻译、图像编辑) */
const MULTIPART_ROUTES: Record<string, string> = {
  "/audio/transcriptions": "/audio/transcriptions",
  "/audio/translations": "/audio/translations",
  "/images/edits": "/images/edits",
};

export const gateway = new Hono<{ Bindings: Env }>();

gateway.use("*", requireGatewayKey);

for (const [path, azurePath] of Object.entries(JSON_ROUTES)) {
  gateway.post(path, (c) => handleJson(c, azurePath));
}
for (const [path, azurePath] of Object.entries(MULTIPART_ROUTES)) {
  gateway.post(path, (c) => handleMultipart(c, azurePath));
}

/** 汇聚全部节点的模型别名, 伪装成 OpenAI 模型列表 */
gateway.get("/models", (c) => {
  const nodes = loadNodes(c.env);
  const map = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    if (node.enabled === false) continue;
    for (const alias of Object.keys(node.deployments)) {
      if (!map.has(alias)) {
        map.set(alias, {
          id: alias,
          object: "model",
          created: 0,
          owned_by: "azure-ai-manager",
          nodes: [],
        });
      }
      (map.get(alias)!.nodes as string[]).push(node.name);
    }
  }
  return c.json({ object: "list", data: [...map.values()] });
});

// ---------- 处理器 ----------

function jsonError(c: Context<{ Bindings: Env }>, status: ContentfulStatusCode, message: string) {
  return c.json({ error: { message, type: "azure_ai_gateway_error", code: status } }, status);
}

function upstreamUrl(
  node: { endpoint: string },
  deployment: string,
  azurePath: string,
  env: Env
): string {
  return `${node.endpoint}/openai/deployments/${encodeURIComponent(deployment)}${azurePath}?api-version=${defaultApiVersion(env)}`;
}

function upstreamHeaders(node: { apiKey: string }, opts: { json: boolean; stream: boolean }): Headers {
  const h = new Headers({ "api-key": node.apiKey });
  if (opts.json) h.set("content-type", "application/json");
  if (opts.stream) h.set("accept", "text/event-stream");
  return h;
}

/**
 * JSON 推理代理: 读取请求体 -> 解析 model 别名 -> 剥离 model 字段 ->
 * 按候选序列依次尝试 (429/5xx/网络错误自动切换下一个节点) -> 原样透传响应。
 * 流式请求 body 直接透传 (零拷贝), 不缓冲内存。
 */
async function handleJson(c: Context<{ Bindings: Env }>, azurePath: string) {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return jsonError(c, 400, "Request body must be valid JSON");
  }

  const model = typeof body.model === "string" ? body.model : null;
  if (!model) return jsonError(c, 400, "`model` is required");

  const candidates = new Balancer(loadNodes(c.env)).candidates(model);
  if (candidates.length === 0) {
    return jsonError(c, 404, `No available deployment for model '${model}'`);
  }

  const isStream = body.stream === true;
  // 流式 chat 请求注入 usage 统计帧 (Phase 2 用量统计依赖此字段)
  if (isStream && azurePath === "/chat/completions" && body.stream_options == null) {
    body.stream_options = { include_usage: true };
  }
  delete body.model;
  const payload = JSON.stringify(body);

  const timeoutMs = requestTimeoutMs(c.env);
  const attempts = Math.min(MAX_ATTEMPTS, candidates.length);
  let lastError = "unknown error";

  for (let i = 0; i < attempts; i++) {
    const node = candidates[i];
    const deployment = node.deployments[model];
    try {
      const upstream = await fetch(upstreamUrl(node, deployment, azurePath, c.env), {
        method: "POST",
        headers: upstreamHeaders(node, { json: true, stream: isStream }),
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 瞬态错误且有下一跳 -> 换节点重试
      if (isTransientStatus(upstream.status) && i < attempts - 1) {
        lastError = `node '${node.name}' returned HTTP ${upstream.status}`;
        continue;
      }
      return new Response(upstream.body, upstream);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return jsonError(c, 502, `All ${attempts} upstream node(s) failed. Last error: ${lastError}`);
}

/**
 * multipart 代理 (audio/transcriptions 等):
 * 读取 FormData 解析 model 字段, 剥离后重建 FormData 转发。
 */
async function handleMultipart(c: Context<{ Bindings: Env }>, azurePath: string) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return jsonError(c, 400, "Request body must be multipart/form-data");
  }

  const modelRaw = form.get("model");
  const model = typeof modelRaw === "string" ? modelRaw.trim() : null;
  if (!model) return jsonError(c, 400, "`model` field is required in form data");

  const candidates = new Balancer(loadNodes(c.env)).candidates(model);
  if (candidates.length === 0) {
    return jsonError(c, 404, `No available deployment for model '${model}'`);
  }

  const forward = new FormData();
  for (const [key, value] of form.entries()) {
    if (key === "model") continue;
    forward.append(key, value);
  }

  const timeoutMs = requestTimeoutMs(c.env);
  const attempts = Math.min(MAX_ATTEMPTS, candidates.length);
  let lastError = "unknown error";

  for (let i = 0; i < attempts; i++) {
    const node = candidates[i];
    const deployment = node.deployments[model];
    try {
      const upstream = await fetch(upstreamUrl(node, deployment, azurePath, c.env), {
        method: "POST",
        headers: upstreamHeaders(node, { json: false, stream: false }),
        body: forward,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isTransientStatus(upstream.status) && i < attempts - 1) {
        lastError = `node '${node.name}' returned HTTP ${upstream.status}`;
        continue;
      }
      return new Response(upstream.body, upstream);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return jsonError(c, 502, `All ${attempts} upstream node(s) failed. Last error: ${lastError}`);
}
