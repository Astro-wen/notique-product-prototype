-- Freeze routing metadata, never credentials. NULL keeps historical tasks on
-- their original global profile. Apply before starting the 1.6.1 worker.
ALTER TABLE event_ai_artifact_runs ADD COLUMN provider_profile TEXT;
ALTER TABLE event_ai_artifact_runs ADD COLUMN provider_base_url TEXT;
