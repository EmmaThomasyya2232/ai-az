import type { Env } from "../types";

/**
 * 阶段六: 系统配置表 (system_configs) 读写。
 * 提供面板 / Admin API 可动态调整的基础配置, 优先于环境变量。
 * 常用 key:
 *   warmup_enabled       on|off          养号打卡全局开关
 *   warmup_model                         打卡模型 (默认 text-embedding-3-small)
 *   warmup_default_region                默认合规区域
 *   alert_webhook_url                    通知 Webhook (Telegram/飞书转达)
 */

export async function getSystemConfig(env: Env, key: string): Promise<string | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB
      .prepare("SELECT config_value FROM system_configs WHERE config_key = ?1")
      .bind(key)
      .first<{ config_value: string }>();
    return row?.config_value ?? null;
  } catch (e) {
    console.warn("system_config read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function setSystemConfig(env: Env, key: string, value: string): Promise<void> {
  if (!env.DB) return;
  await env.DB!
    .prepare(
      `INSERT INTO system_configs (config_key, config_value, updated_at)
       VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(config_key) DO UPDATE SET
         config_value = excluded.config_value,
         updated_at = datetime('now')`
    )
    .bind(key, value)
    .run();
}

export async function deleteSystemConfig(env: Env, key: string): Promise<boolean> {
  if (!env.DB) return false;
  const res = await env.DB!.prepare("DELETE FROM system_configs WHERE config_key = ?1").bind(key).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 列出现有全部非敏感系统配置 */
export async function listSystemConfigs(env: Env): Promise<Array<{ key: string; value: string; updatedAt: string | null }>> {
  if (!env.DB) return [];
  try {
    const res = await env.DB
      .prepare("SELECT config_key, config_value, updated_at FROM system_configs ORDER BY config_key")
      .all<{ config_key: string; config_value: string; updated_at: string }>();
    return (res.results ?? []).map((r) => ({
      key: r.config_key,
      value: r.config_value,
      updatedAt: r.updated_at ?? null,
    }));
  } catch (e) {
    console.warn("system_config list failed:", e instanceof Error ? e.message : e);
    return [];
  }
}