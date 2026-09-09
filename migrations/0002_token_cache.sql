-- 阶段二: 三层令牌缓存 (L1 isolate 内存 -> L2 D1 -> L3 Entra ID 上游刷新)
-- service_principals: Entra ID 服务主体凭据 (client_secret AES-GCM 加密存储)
CREATE TABLE IF NOT EXISTS service_principals (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- token_cache: L2 令牌缓存 (令牌 AES-GCM 加密, expires_at 为 Unix 秒)
CREATE TABLE IF NOT EXISTS token_cache (
  cache_key  TEXT PRIMARY KEY,
  token_enc  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
