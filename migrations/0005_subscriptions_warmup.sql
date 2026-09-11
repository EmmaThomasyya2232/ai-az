-- 阶段六: 订阅元数据 + 养号打卡 + 系统配置
-- azure_subscriptions 在录入服务主体时通过 ARM /subscriptions 自动发现入库,
-- 并承载 Tier / 区域白名单 / 打卡状态等资产画像。

-- 1. 订阅资产画像表
-- allowed_regions: JSON 数组 ["centralus", "canadacentral"]; NULL = 尚未探测(视为全区域合规)
-- warmup_status:   Pending(未上架) / Active(已上架打卡中) / Upgraded(已提档, 停止打卡) / Disabled(手动关闭)
-- warmup_target:   是否已一键上架 (safe-bootstrap 后置 1)
CREATE TABLE IF NOT EXISTS azure_subscriptions (
  id               TEXT PRIMARY KEY,   -- subscriptionId
  sp_id            TEXT NOT NULL,      -- 归属服务主体 id
  subscription_name TEXT NOT NULL DEFAULT '',
  current_tier     TEXT NOT NULL DEFAULT 'Unknown',
  allowed_regions  TEXT,               -- JSON 数组或 NULL
  warmup_status    TEXT NOT NULL DEFAULT 'Pending',
  warmup_target    INTEGER NOT NULL DEFAULT 0,
  upgrade_unavailability_reason TEXT,
  last_tier_checked_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_sp ON azure_subscriptions (sp_id);

-- 2. 每日养号打卡流水日志表
CREATE TABLE IF NOT EXISTS warmup_logs (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL,
  instance_name    TEXT NOT NULL,
  model_name       TEXT NOT NULL,
  tokens_consumed  INTEGER NOT NULL DEFAULT 0,
  status_code      INTEGER,
  response_time_ms INTEGER,
  result_status    TEXT,               -- Success / Failed
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warmup_logs_sub_ts ON warmup_logs (subscription_id, created_at);

-- 3. 系统配置表 (通知 Webhook 与全局开关; 支持面板/API 动态调整)
CREATE TABLE IF NOT EXISTS system_configs (
  config_key   TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);