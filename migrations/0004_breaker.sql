-- 阶段五: 节点熔断状态机 (D1 持久化, 跨 isolate 共享)
-- state: closed(正常) -> open(熔断, failures 达阈值) -> half_open(冷却到期后放行探测)
--        half_open 成功 -> 删行(恢复 closed); 失败 -> 重新 open (opened_at 重新计时)
-- opened_at 为 epoch 毫秒, 便于原子抢占比较
CREATE TABLE IF NOT EXISTS node_health (
  node_name      TEXT PRIMARY KEY,
  state          TEXT    NOT NULL DEFAULT 'closed',
  failures       INTEGER NOT NULL DEFAULT 0,
  opened_at      INTEGER,
  last_error     TEXT,
  last_probed_at TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
