CREATE INDEX source_events_tenant_occurred_at_idx
  ON source_events (tenant_id, occurred_at);

CREATE INDEX incidents_tenant_last_event_at_idx
  ON incidents (tenant_id, last_event_at);

CREATE INDEX incident_events_event_id_idx
  ON incident_events (event_id);
