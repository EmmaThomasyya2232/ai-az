-- 阶段二: 节点池持久化 (唯一持久层为 D1, 零 KV / 零 DO / 零 R2)
-- api_key_enc: AES-GCM 加密后的凭据, 格式 "v1:<iv_b64>:<ciphertext_b64>"
-- deployments: JSON 对象, 对外模型别名 -> Azure 部署名
CREATE TABLE IF NOT EXISTS nodes (
  name         TEXT PRIMARY KEY,
  endpoint     TEXT    NOT NULL,
  api_key_enc  TEXT    NOT NULL,
  deployments  TEXT    NOT NULL,
  weight       INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
