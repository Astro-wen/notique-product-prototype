-- 第二层：记下这条记录的项目是谁定的。
-- 用户在选择器里选过的材料，第三层的建议必须闭嘴，所以「谁定的」要和记录一起存。
-- 可空：迁移之前的记录没有来源，等同于没人选过。
ALTER TABLE events ADD COLUMN routing_source TEXT;
--> statement-breakpoint

-- 第三层：判断方给出的归属建议。只是一条只读的数据，没有任何搬动动作。
-- 每条记录最多一条在手的建议，所以 event_id 直接做主键：重跑覆盖，不堆历史。
CREATE TABLE IF NOT EXISTS event_routing_suggestions (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  -- 被建议的项目删掉之后，这条建议就没有意义了，跟着一起走。
  suggested_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 阈值判断建立在它是 0 到 1 上，越界的值直接拒绝入库。
  probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  judge TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 用户看过并划掉之后填上。填了就不再展示，但保留下来，免得下一轮重算又弹一次。
  dismissed_at TEXT
);
--> statement-breakpoint

-- 项目被删时要按 suggested_project_id 找到挂着的建议。
CREATE INDEX IF NOT EXISTS idx_event_routing_suggestions_project
  ON event_routing_suggestions (suggested_project_id);
