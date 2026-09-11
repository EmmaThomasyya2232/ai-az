import { Hono } from "hono";
import type { Env } from "./types";
import { ConfigError } from "./core/config";
import { TokenError } from "./core/token-cache";
import { runPatrol } from "./core/patrol";
import { runDailyWarmup } from "./core/warmup";
import { gateway } from "./routes/gateway";
import { admin } from "./routes/admin";
import { apiAlias } from "./routes/api-alias";

const app = new Hono<{ Bindings: Env }>();

// 推理网关: /v1/*
app.route("/v1", gateway);
// 管理 API: /admin/* (Phase 4 扩展为完整管理面板后端)
app.route("/admin", admin);
// 兼容别名: 计划定义的外部入口 /api/* (同一批处理器, 仍走 ADMIN_TOKEN 鉴权)
app.route("/api", apiAlias);

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
  // 阶段五/六: 定时巡检 (节点探活/令牌预热/日志清理) + 每日养号打卡 (UTC 04:00 ≈ 北京时间 12:00)
  // 本地测试 (wrangler 4):
  //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"
  //   curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+4+*+*+*"
  scheduled: async (event, env) => {
    const cron = event.cron;
    const isDailyWarmup = cron.includes("0 4") || cron.includes("0 12");
    const summary: Record<string, unknown> = { cron };
    const tasks: Promise<unknown>[] = [runPatrol(env, `cron:${cron}`)];
    if (isDailyWarmup) {
      tasks.push(runDailyWarmup(env, `cron:${cron}`));
    }
    const [patrol, warmup] = await Promise.all(tasks);
    summary.patrol = patrol;
    if (warmup) summary.warmup = warmup;
    console.log("scheduled:", JSON.stringify(summary));
  },
} satisfies ExportedHandler<Env>;
