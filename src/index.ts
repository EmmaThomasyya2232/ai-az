import { Hono } from "hono";
import type { Env } from "./types";
import { ConfigError } from "./core/config";
import { TokenError } from "./core/token-cache";
import { runPatrol } from "./core/patrol";
import { gateway } from "./routes/gateway";
import { admin } from "./routes/admin";

const app = new Hono<{ Bindings: Env }>();

// 推理网关: /v1/*
app.route("/v1", gateway);
// 管理 API: /admin/* (Phase 4 扩展为完整管理面板后端)
app.route("/admin", admin);

app.get("/api/health", (c) => c.json({ ok: true, service: "azure-ai-manager" }));

app.onError((err, c) => {
  if (err instanceof ConfigError) {
    return c.json({ error: { message: err.message, type: "config_error" } }, 500);
  }
  if (err instanceof TokenError) {
    return c.json({ error: { message: err.message, type: "upstream_token_error" } }, 502);
  }
  console.error("unhandled error:", err);
  return c.json({ error: { message: "Internal Server Error" } }, 500);
});

// 其余路径回落到静态面板 (run_worker_first=true 时由 Worker 转交 ASSETS)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // 阶段五: 定时巡检 (节点探活 / 令牌预热 / 日志清理); 本地测试:
  // curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
  scheduled: async (event, env) => {
    await runPatrol(env, `cron:${event.cron}`);
  },
} satisfies ExportedHandler<Env>;
