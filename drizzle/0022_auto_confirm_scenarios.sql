-- 项目类型改为自动采用把握最大的候选，不再等人在卡片上确认。
-- 已经停在「等待确认」的项目按同样规则补上，不然它们的卡片还会出现、后面的记录还会被挡。
UPDATE projects
   SET scenario = (
         SELECT json_extract(candidate.value, '$.scenario')
           FROM json_each(projects.scenario_candidates_json) AS candidate
          ORDER BY json_extract(candidate.value, '$.confidence') DESC, candidate.key
          LIMIT 1
       ),
       scenario_status = 'confirmed',
       scenario_version = scenario_version + 1,
       scenario_confirmed_by = 'system:auto-scenario',
       scenario_confirmed_at = CURRENT_TIMESTAMP,
       scenario_lease_expires_at = NULL,
       updated_at = CURRENT_TIMESTAMP
 WHERE scenario_status = 'pending_confirmation'
   AND json_valid(scenario_candidates_json)
   AND json_array_length(scenario_candidates_json) > 0;
