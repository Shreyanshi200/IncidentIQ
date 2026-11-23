ALTER TABLE source_events
  ADD COLUMN clickhouse_archived_at TIMESTAMPTZ;

ALTER TABLE incidents
  ADD COLUMN clickhouse_archived_at TIMESTAMPTZ;

CREATE INDEX source_events_clickhouse_archived_at_idx
  ON source_events (clickhouse_archived_at)
  WHERE clickhouse_archived_at IS NOT NULL;

CREATE INDEX incidents_clickhouse_archived_at_idx
  ON incidents (clickhouse_archived_at)
  WHERE clickhouse_archived_at IS NOT NULL;
