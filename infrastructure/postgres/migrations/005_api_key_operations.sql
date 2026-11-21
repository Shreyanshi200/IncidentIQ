ALTER TABLE api_keys
  ADD COLUMN label TEXT,
  ADD COLUMN expires_at TIMESTAMPTZ;

CREATE INDEX api_keys_tenant_created_at_idx
  ON api_keys (tenant_id, created_at DESC);
