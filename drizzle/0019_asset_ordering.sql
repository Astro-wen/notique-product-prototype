-- 材料可以手动排序。此前列表只按 created_at，用户无法把逐字稿排在录音
-- 前面，也无法按自己讲述的顺序组织一条记录里的材料。
ALTER TABLE assets ADD COLUMN sort_order INTEGER;

-- 按现有的 created_at 顺序回填，迁移前后列表顺序完全一致。同一毫秒的
-- 并列用 id 兜底，保证回填结果唯一。
UPDATE assets SET sort_order = (
  SELECT COUNT(*) FROM assets older
   WHERE older.event_id = assets.event_id
     AND (older.created_at < assets.created_at
          OR (older.created_at = assets.created_at AND older.id < assets.id))
);

CREATE INDEX IF NOT EXISTS idx_assets_event_order ON assets (event_id, sort_order);
