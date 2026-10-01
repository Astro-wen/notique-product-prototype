/** Publish a replacement without deleting the historical transcript or its
 * exact evidence versions. Call inside the canonical transcript transaction. */
export function transcriptionReplacementStatements(
  db: D1Database,
  input: { workspaceId: string; eventId: string; audioVersionId: string; transcriptAssetId: string; timestamp: string },
): D1PreparedStatement[] {
  const { workspaceId, eventId, audioVersionId, transcriptAssetId, timestamp } = input;
  const prior = `SELECT id FROM assets WHERE workspace_id=? AND event_id=? AND kind='transcript'
    AND id<>? AND json_extract(metadata_json,'$.source_audio_asset_version_id')=?
    AND COALESCE(json_extract(metadata_json,'$.analysis_source'),1)<>0
    AND COALESCE(json_extract(metadata_json,'$.transcription_chunk'),0)<>1`;
  const values = [workspaceId, eventId, transcriptAssetId, audioVersionId];
  return [
    db.prepare(`UPDATE events SET source_revision=source_revision+1,updated_at=?
      WHERE workspace_id=? AND id=? AND EXISTS (${prior})`).bind(timestamp, workspaceId, eventId, ...values),
    db.prepare(`UPDATE workflow_narratives SET freshness='stale',updated_at=? WHERE workspace_id=?
      AND project_id=(SELECT project_id FROM events WHERE workspace_id=? AND id=?) AND EXISTS (${prior})`)
      .bind(timestamp, workspaceId, workspaceId, eventId, ...values),
    db.prepare(`DELETE FROM workflow_snapshots WHERE workspace_id=?
      AND project_id=(SELECT project_id FROM events WHERE workspace_id=? AND id=?) AND EXISTS (${prior})`)
      .bind(workspaceId, workspaceId, eventId, ...values),
    db.prepare(`INSERT INTO workflow_outbox (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at)
      SELECT ?,workspace_id,project_id,id,'initial_analysis','material:'||id||':'||source_revision,source_revision,
        json_object('actorId','$material-submission','sourceRevision',source_revision),?,?,?
      FROM events WHERE workspace_id=? AND id=? AND EXISTS (${prior})
      ON CONFLICT(workspace_id,task_key) DO NOTHING`)
      .bind(`mat_${crypto.randomUUID().replaceAll('-', '')}`, timestamp, timestamp, timestamp, workspaceId, eventId, ...values),
    db.prepare(`UPDATE assets SET metadata_json=json_set(COALESCE(metadata_json,'{}'),
      '$.analysis_source',json('false'),'$.superseded_by_transcript_asset_id',?),updated_at=?
      WHERE id IN (${prior})`).bind(transcriptAssetId, timestamp, ...values),
  ];
}
