ALTER TABLE incidents
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;

UPDATE incidents
SET last_event_at = started_at
WHERE last_event_at > started_at;

CREATE TABLE incident_events (
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES source_events (event_id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, event_id)
);

CREATE INDEX incidents_open_scope_last_event_idx
  ON incidents (tenant_id, service, environment, last_event_at DESC)
  WHERE state = 'open';
