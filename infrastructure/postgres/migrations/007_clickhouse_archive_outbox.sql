CREATE TABLE clickhouse_archive_outbox (
  record_type TEXT NOT NULL CHECK (record_type IN ('event', 'incident')),
  record_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (record_type, record_id)
);

CREATE INDEX clickhouse_archive_outbox_due_idx
  ON clickhouse_archive_outbox (next_attempt_at, queued_at);

CREATE INDEX clickhouse_archive_outbox_tenant_idx
  ON clickhouse_archive_outbox (tenant_id);
