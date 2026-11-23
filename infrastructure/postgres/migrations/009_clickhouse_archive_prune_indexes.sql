DROP INDEX source_events_clickhouse_archived_at_idx;
DROP INDEX incidents_clickhouse_archived_at_idx;

CREATE INDEX source_events_archive_prune_idx
  ON source_events (occurred_at)
  WHERE clickhouse_archived_at IS NOT NULL;

CREATE INDEX incidents_archive_prune_idx
  ON incidents (last_event_at)
  WHERE clickhouse_archived_at IS NOT NULL;
