# Optional ClickHouse archive

ClickHouse is an optional long-term archive for installations whose historical evidence volume has outgrown PostgreSQL-only retention. PostgreSQL remains mandatory and continues to own authentication, ingestion deduplication, incident detection, active dashboard queries, and transactional incident state. With hot/cold tiering enabled, PostgreSQL keeps only a recent operational window while ClickHouse keeps the complete long-term copy.

## How delivery works

When `CLICKHOUSE_URL` is configured, every newly accepted redacted event and updated incident snapshot is added to a PostgreSQL outbox in the same transaction as the operational write. A background worker sends due records to ClickHouse and removes the outbox entries only after ClickHouse accepts them.

Temporary ClickHouse failures therefore do not reject producer traffic or lose the PostgreSQL record. Delivery retries with bounded exponential backoff. The ClickHouse tables use `ReplacingMergeTree`, so replaying an event or newer incident snapshot is safe; exact deduplication is eventually applied by ClickHouse merges.

Successful delivery is recorded explicitly on the PostgreSQL event or incident. Absence from the outbox is not treated as proof of archival. Both automatic and archive-aware manual retention require that confirmation before deleting a PostgreSQL row.

Do not enable ClickHouse merely because it is available. It adds another database, credentials, backups, monitoring, and capacity planning. Use the default PostgreSQL-only path until measured retention or analytics volume justifies it.

## Test locally

Apply the new PostgreSQL migration:

```sh
pnpm incidentiq init
```

Start the optional ClickHouse profile:

```sh
docker compose --profile scale up -d clickhouse
```

Add these values to `.env`:

```text
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=incidentiq
CLICKHOUSE_USERNAME=incidentiq
CLICKHOUSE_PASSWORD=incidentiq
```

Leave `INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS` unset during the first archive verification so the newly ingested fixture is visible in both the active and read-only archive views. Enable a conservative hot window only after backfill and delivery checks succeed.

Restart the API so it reads the new configuration:

```sh
pnpm api
```

Send a new fixture through the authenticated API. Use a fresh tenant or clear the old test tenant first so stable fixture event IDs are accepted rather than reported as duplicates:

```sh
pnpm incidentiq fixture ingest demo/fixtures/production-commerce-platform-cascade.json --tenant clickhouse-test
```

The archive normally drains within five seconds. Check the durable delivery queue:

```sh
pnpm incidentiq archive status --tenant clickhouse-test
```

Expected after successful delivery:

```json
{
  "queued": 0,
  "retrying": 0,
  "oldest_queued_at": null
}
```

Open the dashboard with a read key for `clickhouse-test`, then select **Archived**. The fixture should appear as a read-only ClickHouse investigation with Analysis and Evidence tabs. Filters and pagination are evaluated by the API against ClickHouse; the browser never receives ClickHouse credentials.

Query the archived events and incident snapshots directly:

```sh
docker compose exec clickhouse clickhouse-client --user incidentiq --password incidentiq --query "SELECT tenant_id, count() AS events FROM incidentiq.source_events GROUP BY tenant_id ORDER BY tenant_id"
```

```sh
docker compose exec clickhouse clickhouse-client --user incidentiq --password incidentiq --query "SELECT tenant_id, service, argMax(event_count, updated_at) AS latest_event_count FROM incidentiq.incidents GROUP BY tenant_id, service ORDER BY tenant_id, service"
```

## Backfill existing PostgreSQL data

Enabling ClickHouse archives new writes. Queue existing PostgreSQL events and current incident snapshots explicitly:

```sh
pnpm incidentiq archive backfill --tenant <tenant-id>
```

Omit `--tenant` only when you intentionally want to queue every tenant. The command is idempotent for events and deliberately requeues current incident snapshots so ClickHouse receives their latest state.

Keep the API running until the queue drains:

```sh
pnpm incidentiq archive status --tenant <tenant-id>
```

## Production configuration

Create a dedicated ClickHouse database first, then use a least-privilege account that can create tables and insert rows inside that database. Prefer your provider's HTTPS endpoint and store `CLICKHOUSE_PASSWORD` in the same server-side secret system as `DATABASE_URL`.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLICKHOUSE_URL` | unset | Enables archival; must use HTTP or HTTPS |
| `CLICKHOUSE_DATABASE` | `incidentiq` | Existing database where the API creates archive tables |
| `CLICKHOUSE_USERNAME` | `default` | HTTP API user |
| `CLICKHOUSE_PASSWORD` | empty | HTTP API password |
| `INCIDENTIQ_CLICKHOUSE_BATCH_SIZE` | `500` | Maximum outbox records processed per flush |
| `INCIDENTIQ_CLICKHOUSE_FLUSH_INTERVAL_MS` | `5000` | Delay between background flush attempts |
| `INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS` | unset | Enables automatic hot/cold tiering and keeps this many recent days in PostgreSQL |
| `INCIDENTIQ_POSTGRES_PRUNE_INTERVAL_MINUTES` | `60` | How often the API checks for confirmed rows outside the hot window |

The API readiness endpoint intentionally checks PostgreSQL only. ClickHouse is an optional archive and must not make ingestion unavailable. Monitor the dashboard **Evidence storage** panel or `archive status`: a growing `queued` count or non-zero `retrying` count indicates delivery trouble.

## Retention and recovery boundaries

- Automatic tiering is disabled unless `INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS` is explicitly set.
- Automatic tiering deletes only rows whose successful ClickHouse delivery has been recorded and whose incident activity/event occurrence is older than the hot cutoff.
- Manual `data prune` also requires confirmed archival whenever `CLICKHOUSE_URL` is present in the CLI environment. Without ClickHouse configured it retains its existing PostgreSQL-only behavior.
- PostgreSQL pruning skips records that are still waiting in the ClickHouse outbox.
- `data clear --tenant ... --confirm` is an explicit destructive test/cleanup command and also removes that tenant's pending archive work. It does not delete rows already delivered to ClickHouse.
- ClickHouse retention, backups, replicas, storage policy, and deletion requests are owned by the operator. No TTL is imposed automatically.
- The dashboard labels whether the tenant is using PostgreSQL-only storage, archive-only copying, or automatic hot/cold tiering and shows pending/retrying delivery counts. Active investigations still read PostgreSQL. The separate tenant-scoped **Archived** page reads latest incident snapshots from ClickHouse with service, environment, cause, date, and cursor filters; direct SQL remains available for broader event analytics.
- ClickHouse receives the same redacted attributes stored by the ingestion API. It never receives API-key hashes or dashboard session secrets.

Before disabling archival, let `archive status` reach zero. Then remove `CLICKHOUSE_URL` and restart the API. Existing ClickHouse rows are unchanged.

If the archive has been permanently abandoned while records remain queued, explicitly discard only that tenant's pending delivery work before resuming PostgreSQL pruning:

```sh
pnpm incidentiq archive discard --tenant <tenant-id> --confirm
```

This does not delete PostgreSQL records or rows already delivered to ClickHouse. Without this confirmed command, pending work remains durable so a temporary configuration change cannot silently lose archive delivery.
