CREATE TABLE source_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  tenant_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  service TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  version TEXT,
  trace_id TEXT,
  resource TEXT,
  attributes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX source_events_service_environment_occurred_at_idx
  ON source_events (service, environment, occurred_at DESC);
