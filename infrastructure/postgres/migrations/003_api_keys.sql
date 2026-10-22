CREATE TABLE api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  visible_prefix TEXT NOT NULL,
  scope TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_active_hash_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;
