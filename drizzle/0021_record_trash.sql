-- 单条记录的回收站。
--
-- 做法是把记录搬进每个工作区一个的隐藏项目，这个项目本身就处在回收站里
-- (deleted_at 非空)。全站读取都已经排除回收站里的项目，所以记录搬进去就从
-- 所有地方消失，不用在九十多处查询里各加一个过滤。system_role 标出这个项目
-- 是系统用的，回收站列表、恢复、永久删除都要绕开它。
ALTER TABLE projects ADD COLUMN system_role TEXT;
--> statement-breakpoint

-- 记录原来在哪个项目、排第几，恢复时按这里搬回去。
CREATE TABLE IF NOT EXISTS trashed_events (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  -- 原项目被永久删除时，它名下在回收站里的记录一起清掉，这里不设外键，由仓储层处理。
  original_project_id TEXT NOT NULL,
  original_sequence_no INTEGER NOT NULL,
  -- 删的是项目第一条、场景还等着确认时，场景候选是从这条记录判出来的，删的时候
  -- 清掉，快照存在这里。误删后恢复，候选跟着回来，不用重跑一遍分析。
  scenario_snapshot_json TEXT,
  -- 删掉第一条时顶上来当第一条的那条记录和它原来的序号。恢复时换回去，
  -- 撤销之后记录的顺序和删之前一模一样。
  promoted_event_id TEXT,
  promoted_from_sequence_no INTEGER,
  trashed_at TEXT NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_trashed_events_workspace
  ON trashed_events (workspace_id, trashed_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_trashed_events_project
  ON trashed_events (original_project_id);
