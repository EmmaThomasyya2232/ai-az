-- 阶段三: 用量统计与配额限流 (唯一持久层仍为 D1)

-- gateway_keys: D1 化网关 Key。只存 SHA-256 摘要 (明文仅创建时返回一次);
-- key_prefix/key_suffix 仅为面板识别用 (前 8 位 / 后 4 位)。
CREATE TABLE IF NOT EXISTS gateway_keys (
  id                   TEXT PRIMARY KEY,
  key_hash             TEXT    NOT NULL UNIQUE,
  key_prefix           TEXT    NOT NULL,
  key_suffix           TEXT    NOT NULL,
  label                TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  rate_limit_per_min   INTEGER,           -- NULL = 不限
  daily_request_quota  INTEGER,           -- NULL = 不限
  daily_token_quota    INTEGER,           -- NULL = 不限 (prompt+completion)
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- rate_limits: 固定分钟窗口计数器 (原子 UPSERT ... RETURNING count)
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash     TEXT    NOT NULL,
  window_start INTEGER NOT NULL,          -- Unix 秒, 对齐分钟
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, window_start)
);

-- usage_daily: 每日用量聚合 (请求与 token 累计, 供配额判定与统计)
CREATE TABLE IF NOT EXISTS usage_daily (
  key_hash          TEXT    NOT NULL,
  day               TEXT    NOT NULL,      -- UTC 'YYYY-MM-DD'
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, day)
);

-- request_logs: 单次请求日志 (异步 waitUntil 写入)
CREATE TABLE IF NOT EXISTS request_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT    NOT NULL DEFAULT (datetime('now')),
  key_id            TEXT,
  node              TEXT,
  deployment        TEXT,
  path              TEXT,
  status            INTEGER,
  latency_ms        INTEGER,
  stream            INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs (ts);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_ts ON request_logs (key_id, ts);
