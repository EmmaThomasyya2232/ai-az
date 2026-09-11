import type { Env } from "../types";

/**
 * 阶段五: Webhook 告警。
 * 通过 ALERT_WEBHOOK_URL 推送事件 (节点熔断/恢复、巡检异常、令牌刷新失败等)。
 * 支持 json (默认, 结构化) / slack / discord / feishu 四种载荷格式;
 * 未配置 URL 或 ALERTS_ENABLED=off 时为无操作。永不抛出 (告警失败不影响主流程)。
 */

export type AlertLevel = "info" | "warn" | "error";

export interface AlertPayload {
  /** 机器可读事件名, 如 node.circuit_opened */
  event: string;
  level: AlertLevel;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

export function alertsEnabled(env: Env): boolean {
  return env.ALERTS_ENABLED !== "off";
}

function buildPayload(format: string, p: AlertPayload): unknown {
  const line = `*${p.title}*\n${p.message}`;
  switch (format) {
    case "slack":
      return { text: line };
    case "discord":
      return { content: `**${p.title}**\n${p.message}` };
    case "feishu":
      return { msg_type: "text", content: { text: `${p.title}\n${p.message}` } };
    default:
      return {
        event: p.event,
        level: p.level,
        title: p.title,
        message: p.message,
        details: p.details ?? {},
        time: new Date().toISOString(),
      };
  }
}

/** 发送告警 webhook。返回是否发送成功; 内部吞掉所有错误。 */
export async function sendAlert(
  env: Env,
  p: AlertPayload,
  opts: { webhookUrl?: string } = {}
): Promise<boolean> {
  const url = opts.webhookUrl ?? env.ALERT_WEBHOOK_URL;
  if (!alertsEnabled(env) || !url) return false;
  const format = (env.ALERT_WEBHOOK_FORMAT ?? "json").toLowerCase();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload(format, p)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      console.warn(`webhook alert '${p.event}' returned HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      "webhook alert failed:",
      p.event,
      e instanceof Error ? e.message : e
    );
    return false;
  }
}
