# Operations and guardrails

This guide covers API-key lifecycle, evidence retention, health checks, request limits, and AI usage controls for the supported single-API-process deployment.

## API-key lifecycle

IncidentIQ stores only a SHA-256 hash and a short visible prefix for each key. The raw `iiq_...` value is printed once and must be copied into the relevant secret manager immediately.

Create a labelled ingestion key for a tenant:

```sh
pnpm incidentiq keys create --scope ingest --tenant local --label production-node-sdk
```

Create a read key that expires after 90 days:

```sh
pnpm incidentiq keys create --scope read --tenant local --label operator-dashboard --expires-in-days 90
```

List key metadata without exposing any raw key:

```sh
pnpm incidentiq keys list --tenant local
```

The output includes the key ID, visible prefix, scope, label, creation time, optional expiry, and revocation time. An expired key is rejected automatically.

### Rotate a key safely

Rotation is deliberately a sequence rather than one destructive command:

1. Create a replacement key with a distinct label.
2. Update the application, CI, collector, or operator secret store.
3. Send or read one test request with the replacement.
4. Revoke the old key by its ID.

```sh
pnpm incidentiq keys revoke <old-key-id> --tenant local --confirm
```

Revocation takes effect on the next request. Revoking a read key also invalidates browser sessions created from it.

## Evidence retention

Retention is opt-in and operator-driven. IncidentIQ never deletes evidence on a timer unless you schedule the CLI command yourself.

Preview records older than 90 days:

```sh
pnpm incidentiq data prune --tenant local --older-than 90d
```

The default is a dry run. Review its incident and event counts, take a database backup, then repeat with confirmation:

```sh
pnpm incidentiq data prune --tenant local --older-than 90d --confirm
```

The transaction removes incidents whose latest evidence is older than the cutoff, then removes old source events that are not cited by any retained incident. It preserves API keys, schema migrations, newer incidents, and old context still linked to a retained incident.

Use hours for short-lived test environments:

```sh
pnpm incidentiq data prune --tenant test --older-than 24h --confirm
```

For production, run the same released CLI image from cron or a Kubernetes CronJob after a successful dry run. Do not run overlapping prune jobs for the same tenant.

## Health probes

Liveness confirms that the API process is running without depending on PostgreSQL:

```sh
curl --fail --silent https://incidentiq.example.com/v1/health/live
```

Readiness confirms that the API can query PostgreSQL and is ready for traffic:

```sh
curl --fail --silent https://incidentiq.example.com/v1/health/ready
```

`/v1/health` remains a readiness-compatible alias for existing deployments.

## Runtime guardrails

| Variable | Default | Accepted range | Purpose |
| --- | ---: | ---: | --- |
| `INCIDENTIQ_MAX_BODY_KB` | `256` | `16–1024` | Maximum JSON request body size |
| `INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE` | `20` | `1–1000` | Dashboard session attempts per client address |
| `INCIDENTIQ_AI_TIMEOUT_SECONDS` | `60` | `5–120` | OpenAI request timeout |
| `INCIDENTIQ_AI_MAX_OUTPUT_TOKENS` | `8000` | `1000–8000` | Maximum model output budget |
| `INCIDENTIQ_AI_MAX_INPUT_KB` | `512` | `64–4096` | Maximum serialized incident size sent to OpenAI |
| `INCIDENTIQ_AI_REQUESTS_PER_HOUR` | `10` | `1–100` | AI generations per tenant per API process |
| `INCIDENTIQ_AI_MAX_TIMELINE_EVENTS` | `100` | `10–500` | Largest incident sent for AI review |
| `INCIDENTIQ_AI_REASONING_EFFORT` | `low` | `low`, `medium`, `high` | Model reasoning effort |

Production mode additionally requires a stable `INCIDENTIQ_SESSION_SECRET`. The API adds request IDs, disables the framework signature header, sends defensive response headers, rejects oversized bodies, closes PostgreSQL during graceful shutdown, and emits one JSON request log per completed request. Logs contain request metadata but not authorization headers or request bodies.

Production mode trusts exactly one reverse-proxy hop when determining the client address used for dashboard session limits. This matches the supported Nginx-to-API deployment. Keep the API loopback-bound as shown in the production guide; do not expose it directly or add another proxy layer without updating this topology.

When optional ClickHouse archival is enabled, check the dashboard **Evidence storage** panel or run `pnpm incidentiq archive status` before PostgreSQL retention. Pruning automatically preserves records still in the archive outbox and, when ClickHouse is configured, manual pruning counts only rows with confirmed archive delivery. A growing or retrying queue requires fixing ClickHouse delivery rather than widening PostgreSQL deletion.

For automatic hot/cold tiering, set `INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS` to the measured operational window required by incident correlation and active dashboard use. The API periodically removes only confirmed events and incident snapshots older than that cutoff. Start conservatively—for example, 30 days—observe investigation needs and archive delivery, then shorten it only with evidence. Leave the value unset when PostgreSQL-only retention or operator-scheduled pruning is preferred.

Session and AI rate counters are in memory because the supported deployment uses one API process. They reset after restart and are not a distributed quota or billing system. A future multi-instance deployment must move these counters to shared infrastructure.
