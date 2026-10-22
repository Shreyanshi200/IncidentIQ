CREATE TABLE incidents (
  incident_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  leading_cause TEXT NOT NULL,
  confidence TEXT NOT NULL,
  investigation JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX incidents_started_at_idx ON incidents (started_at DESC);
