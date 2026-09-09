import type { Env } from "../types";
import { defaultApiVersion, loadNodes } from "./config";
import { listSpsFromD1 } from "./sp";
import { getAccessToken } from "./token-cache";
import { armScope } from "./arm";
import { usageLoggingEnabled, purgeUsageLogs } from "./usage";
import {
  recordFailure,
  recordSuccess,
  markProbed,
  breakerEnabled,
  breakerThreshold,
} from "./breaker";
import { sendAlert } from "./notify";

/**
 * 阶段五: 定时巡检 (Cron 触发 / 管理端手动触发)。
 *   1. 节点探活: GET /openai/models (零 token 成本), 联动熔断状态机自愈;
 *   2. 令牌预热 (养号): 剩余有效期进入窗口的 SP 令牌提前刷新, 用户请求不再承担刷新延迟;
 *   3. 日志清理: 按 LOG_RETENTION_DAYS 滚动删除过期请求日志。
 * 异常通过 Webhook 告警 (节点熔断/恢复、令牌刷新失败、巡检汇总)。
 */

export interface PatrolSummary {
  trigger: string;
  startedAt: string;
  durationMs: number;
  probe: {
    enabled: boolean;
    total: number;
    ok: number;
    failures: Array<{ node: string; status: number; error: string | null }>;
  };
  prewarm: {
    enabled: boolean;
    total: number;
    refreshed: number;
    failures: Array<{ sp: string; error: string }>;
  };
  cleanup: { enabled: boolean; deleted: number };
  circuit: { opened: string[]; recovered: string[] };
}

const PROBE_TIMEOUT_MS = 10_000;

function intOr(v: string | undefined, def: number): number {
  const n = Math.floor(Number(v ?? ""));
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export async function runPatrol(env: Env, trigger: string): Promise<PatrolSummary> {
  const started = Date.now();
  const summary: PatrolSummary = {
    trigger,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    probe: { enabled: env.CRON_PROBE_NODES !== "off", total: 0, ok: 0, failures: [] },
    prewarm: { enabled: env.CRON_PREWARM_TOKENS !== "off", total: 0, refreshed: 0, failures: [] },
    cleanup: { enabled: env.CRON_CLEANUP_LOGS !== "off", deleted: 0 },
    circuit: { opened: [], recovered: [] },
  };

  // 1. 节点探活 (含熔断联动自愈)
  if (summary.probe.enabled) {
    let nodes: Awaited<ReturnType<typeof loadNodes>> = [];
    try {
      nodes = await loadNodes(env);
    } catch (e) {
      console.warn("patrol: no node pool:", e instanceof Error ? e.message : e);
    }
    for (const node of nodes) {
      if (node.enabled === false) continue;
      summary.probe.total++;
      let status = 0;
      let err: string | null = null;
      try {
        const resp = await fetch(
          `${node.endpoint}/openai/models?api-version=${defaultApiVersion(env)}`,
          {
            method: "GET",
            headers: { "api-key": node.apiKey },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }
        );
        status = resp.status;
        if (!resp.ok) err = (await resp.text().catch(() => "")).slice(0, 200);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      const ok = err === null && status >= 200 && status < 300;
      if (ok) summary.probe.ok++;
      if (breakerEnabled(env)) {
        if (ok) {
          await markProbed(env, node.name);
          const s = await recordSuccess(env, node.name);
          if (s.closed) {
            summary.circuit.recovered.push(node.name);
            void sendAlert(env, {
              event: "node.circuit_recovered",
              level: "info",
              title: "节点熔断恢复",
              message: `节点 '${node.name}' 巡检探活成功, 熔断已闭合`,
            });
          }
        } else {
          const f = await recordFailure(
            env,
            node.name,
            `probe HTTP ${status || "network"}: ${err ?? "unknown"}`,
            { threshold: breakerThreshold(env) }
          );
          if (f.opened) {
            summary.circuit.opened.push(node.name);
            void sendAlert(env, {
              event: "node.circuit_opened",
              level: "error",
              title: "节点熔断打开",
              message: `节点 '${node.name}' 连续失败达到阈值, 已熔断 (冷却后自动半开探测)`,
              details: { node: node.name, lastError: err },
            });
          }
        }
      }
      if (!ok) summary.probe.failures.push({ node: node.name, status, error: err });
    }
  }

  // 2. 服务主体令牌预热 (养号)
  if (summary.prewarm.enabled && env.DB) {
    let sps: Awaited<ReturnType<typeof listSpsFromD1>> = null;
    try {
      sps = await listSpsFromD1(env);
    } catch {
      sps = null;
    }
    if (sps) {
      const skewMs = intOr(env.TOKEN_PREWARM_WINDOW_SEC, 1800) * 1000;
      for (const sp of sps) {
        summary.prewarm.total++;
        try {
          const r = await getAccessToken(env, {
            tenantId: sp.tenantId,
            clientId: sp.clientId,
            clientSecret: sp.clientSecret,
            scope: armScope(env),
            skewMs,
          });
          if (r.source === "upstream") summary.prewarm.refreshed++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          summary.prewarm.failures.push({ sp: sp.id, error: msg });
          void sendAlert(env, {
            event: "sp.token_refresh_failed",
            level: "error",
            title: "服务主体令牌刷新失败",
            message: `SP '${sp.id}': ${msg}`,
          });
        }
      }
    }
  }

  // 3. 过期日志清理
  if (summary.cleanup.enabled && usageLoggingEnabled(env)) {
    const days = intOr(env.LOG_RETENTION_DAYS, 7);
    summary.cleanup.deleted = await purgeUsageLogs(env, days).catch(() => 0);
  }

  summary.durationMs = Date.now() - started;

  // 4. 巡检异常汇总告警
  if (
    summary.probe.failures.length > 0 ||
    summary.prewarm.failures.length > 0 ||
    summary.circuit.opened.length > 0
  ) {
    void sendAlert(env, {
      event: "patrol.summary",
      level: "warn",
      title: "定时巡检发现异常",
      message: `探活失败 ${summary.probe.failures.length}/${summary.probe.total}, 令牌刷新失败 ${summary.prewarm.failures.length}/${summary.prewarm.total}, 熔断打开: ${summary.circuit.opened.join(", ") || "无"}`,
      details: summary as unknown as Record<string, unknown>,
    });
  }
  return summary;
}
