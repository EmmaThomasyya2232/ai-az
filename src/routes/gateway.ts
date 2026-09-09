import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import { loadNodes, defaultApiVersion, requestTimeoutMs, isTransientStatus } from "../core/config";
import { Balancer } from "../core/balancer";
import { requireGatewayKey } from "../core/auth";
import type { ResolvedGatewayKey } from "../core/gateway-keys";
import {
  checkRateAndQuota,
  recordUsage,
  usageLoggingEnabled,
  extractUsageFromResponse,
  type UsageMeta,
} from "../core/usage";

const MAX_ATTEMPTS = 3;

/** 网关上下文类型: gwKey 由 requireGatewayKey 解析后挂载 */
type GWEnv = { Bindings: Env; Variables: { gwKey: ResolvedGatewayKey } };


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

export const gateway = new Hono<GWEnv>();

gateway.use("*", requireGatewayKey);


for (const [path, azurePath] of Object.entries(JSON_ROUTES)) {
  gateway.post(path, (c) => handleJson(c, azurePath));
}
for (const [path, azurePath] of Object.entries(MULTIPART_ROUTES)) {
  gateway.post(path, (c) => handleMultipart(c, azurePath));
}

/** 汇聚全部节点的模型别名, 伪装成 OpenAI 模型列表 */
gateway.get("/models", async (c) => {
  const nodes = await loadNodes(c.env);
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

function jsonError(c: Context<GWEnv>, status: ContentfulStatusCode, message: string) {
  return c.json({ error: { message, type: "azure_ai_gateway_error", code: status } }, status);
}

/** 组装用量日志元数据 (keyId/keyHash 依解析来源而定) */
function usageMetaOf(
  c: Context<GWEnv>,
  meta: { node: string; deployment: string; path: string; stream: boolean }
): UsageMeta {
  const key = c.get("gwKey");
  return {
    ...meta,
    keyId: key.source === "d1" ? key.record.id : key.id,
    keyHash: key.source === "d1" ? key.record.keyHash : key.keyHash,
  };
}

/**
 * 阶段三: 带用量跟踪的上游响应。
 * 通过 body.tee() 把响应一分为二: 客户端照常零拷贝透传,
 * 日志分支在 waitUntil 中异步消费并提取 usage (JSON 解析 / SSE 末帧)。
 */
function trackedResponse(
  c: Context<GWEnv>,
  upstream: Response,
  meta: { node: string; deployment: string; path: string; stream: boolean },
  started: number
): Response {
  if (!usageLoggingEnabled(c.env) || !upstream.body) {
    return new Response(upstream.body, upstream);
  }
  const [clientBody, logBody] = upstream.body.tee();
  const full = usageMetaOf(c, meta);
  const status = upstream.status;
  const contentType = upstream.headers.get("content-type");
  const stream = meta.stream;
  c.executionCtx.waitUntil(
    extractUsageFromResponse(logBody, contentType, stream).then((tokens) =>
      recordUsage(c.env, full, status, Date.now() - started, tokens, null)
    )
  );
  return new Response(clientBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/** 阶段三: 上游调用前的限流/配额卡点 (禁用 Key 403 / 超限 429 + Retry-After) */
async function gateCheck(c: Context<GWEnv>) {
  const gate = await checkRateAndQuota(c.env, c.get("gwKey"));
  if (gate.ok) return null;
  const headers: Record<string, string> = {};
  if (gate.retryAfterSec !== undefined) headers["retry-after"] = String(gate.retryAfterSec);
  return c.json(
    {
      error: {
        message: gate.message,
        type: gate.status === 403 ? "auth_error" : "quota_error",
        code: gate.code,
      },
    },
    gate.status,
    headers
  );
}

/** 记录网关侧失败 (全部上游失败 502) */
function trackGatewayFailure(
  c: Context<GWEnv>,
  meta: { node: string; deployment: string; path: string; stream: boolean },
  started: number,
  error: string
) {
  if (!usageLoggingEnabled(c.env)) return;
  const full = usageMetaOf(c, meta);
  c.executionCtx.waitUntil(
    recordUsage(c.env, full, 502, Date.now() - started, { promptTokens: null, completionTokens: null }, error)
  );
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
async function handleJson(c: Context<GWEnv>, azurePath: string) {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return jsonError(c, 400, "Request body must be valid JSON");
  }

  const model = typeof body.model === "string" ? body.model : null;
  if (!model) return jsonError(c, 400, "`model` is required");

  const gate = await gateCheck(c);
  if (gate) return gate;

  const candidates = new Balancer(await loadNodes(c.env)).candidates(model);
  if (candidates.length === 0) {
    return jsonError(c, 404, `No available deployment for model '${model}'`);
  }

  const isStream = body.stream === true;
  // 流式 chat 请求注入 usage 统计帧 (阶段三用量统计依赖此字段)
  if (isStream && azurePath === "/chat/completions" && body.stream_options == null) {
    body.stream_options = { include_usage: true };
  }
  delete body.model;
  const payload = JSON.stringify(body);

  const timeoutMs = requestTimeoutMs(c.env);
  const attempts = Math.min(MAX_ATTEMPTS, candidates.length);
  let lastError = "unknown error";
  const started = Date.now();

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
      return trackedResponse(c, upstream, {
        node: node.name,
        deployment,
        path: azurePath,
        stream: isStream,
      }, started);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  trackGatewayFailure(
    c,
    { node: candidates[attempts - 1]?.name ?? "unknown", deployment: candidates[attempts - 1]?.deployments[model] ?? model, path: azurePath, stream: isStream },
    started,
    `all ${attempts} upstream node(s) failed: ${lastError}`
  );
  return jsonError(c, 502, `All ${attempts} upstream node(s) failed. Last error: ${lastError}`);
}


/**
 * multipart 代理 (audio/transcriptions 等):
 * 读取 FormData 解析 model 字段, 剥离后重建 FormData 转发。
 */
async function handleMultipart(c: Context<GWEnv>, azurePath: string) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return jsonError(c, 400, "Request body must be multipart/form-data");
  }

  const modelRaw = form.get("model");
  const model = typeof modelRaw === "string" ? modelRaw.trim() : null;
  if (!model) return jsonError(c, 400, "`model` field is required in form data");

  const gate = await gateCheck(c);
  if (gate) return gate;

  const candidates = new Balancer(await loadNodes(c.env)).candidates(model);
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
  const started = Date.now();

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
      return trackedResponse(c, upstream, {
        node: node.name,
        deployment,
        path: azurePath,
        stream: false,
      }, started);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  trackGatewayFailure(
    c,
    { node: candidates[attempts - 1]?.name ?? "unknown", deployment: candidates[attempts - 1]?.deployments[model] ?? model, path: azurePath, stream: false },
    started,
    `all ${attempts} upstream node(s) failed: ${lastError}`
  );
  return jsonError(c, 502, `All ${attempts} upstream node(s) failed. Last error: ${lastError}`);
}

