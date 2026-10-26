# IncidentIQ

Evidence-first production incident investigation, starting as a CLI and local demo.

```text
apps/cli/                       CLI commands and PostgreSQL access
apps/api/                       Authenticated NestJS ingestion API
apps/demo-service/              Runnable SDK integration example
packages/event-schema/          Versioned shared contracts
packages/correlation/           Deterministic, inspectable cause ranking
packages/node-sdk/              Batched, fail-open Node.js telemetry client
infrastructure/postgres/        Shared database migrations
demo/fixtures/                  Repeatable incident scenarios
```

## Version 0.2.0

The project is TypeScript on Node.js. It validates versioned contracts, ingests authenticated event batches through NestJS and Kysely, stores normalized events in PostgreSQL, offers a safe Node.js SDK, and presents deterministic fixture investigations in a reviewer-friendly CLI.

```sh
cp .env.example .env
docker compose up -d postgres

pnpm test
pnpm incidentiq version
pnpm incidentiq init
pnpm incidentiq fixture validate demo/fixtures/deployment-regression.json
pnpm incidentiq fixture load demo/fixtures/deployment-regression.json
pnpm incidentiq events list
pnpm incidentiq correlate demo/fixtures/deployment-regression.json
pnpm incidentiq correlate demo/fixtures/deployment-regression.json --save
pnpm incidentiq incidents list
pnpm incidentiq incidents explain deployment-regression
pnpm incidentiq incidents export deployment-regression --format json
pnpm incidentiq keys create --scope ingest
pnpm incidentiq api start
```

`fixture load` is idempotent: loading the same fixture twice never duplicates source events. `correlate` returns plain-text timeline, ranked causes, score factors, and next checks. Add `--save` to persist an investigation for listing, explanation, or JSON export.

### Node.js SDK

The SDK batches up to 100 normalized events and never throws when the ingestion API is unavailable. It retains up to 1,000 events in memory and drops the oldest when full.

```ts
import { createIncidentIQ } from "@incidentiq/node-sdk";

const incidentiq = createIncidentIQ({ apiKey: process.env.INCIDENTIQ_API_KEY! });
incidentiq.track({
  event_id: crypto.randomUUID(),
  occurred_at: new Date().toISOString(),
  received_at: new Date().toISOString(),
  tenant_id: "local",
  environment: "production",
  service: "orders",
  source: "node_sdk",
  event_type: "exception",
  severity: "error",
  attributes: { message: "database timeout" }
});

await incidentiq.shutdown();
```

### Run the SDK demo service

Start PostgreSQL and the API in separate terminals, then create an ingestion key and start the demo service:

```sh
docker compose up -d postgres
pnpm incidentiq init
pnpm incidentiq keys create --scope ingest

# Terminal 1
pnpm incidentiq api start

# Terminal 2: replace the value with the key shown once above
INCIDENTIQ_API_KEY=iiq_your_key pnpm demo-service
```

Trigger its simulated failure and inspect the stored SDK event after a couple of seconds:

```sh
curl -i "http://localhost:4000/orders?fail=true"
pnpm incidentiq events list
```

The service returns its own `503` response whether IncidentIQ is reachable or not; the SDK only observes and exports the failure.

## Release roadmap

| Version | Status | Outcome |
| --- | --- | --- |
| 0.0.1 | Complete | Versioned contracts and canonical fixtures |
| 0.0.2 | Complete | PostgreSQL migrations and idempotent event storage |
| 0.0.3 | Complete | Deterministic cause ranking |
| 0.0.4 | Complete | Readable local investigation CLI |
| 0.1.0 | Complete | Authenticated event-ingestion API |
| 0.2.0 | Complete | Safe Node.js SDK with batched, fail-open export |
| 0.3.0 | Planned | GitHub Actions deployment context |
| 0.4.0 | Planned | Read-only Kubernetes workload signals |
| 0.5.0 | Planned | Automatic incident detection and unified timeline |
| 0.6.0 | Planned | Evidence-bounded AI explanation |
| 0.8.0 | Planned | Reliability, retention, quotas, and cost controls |
| 0.9.0-1.0.0 | Planned | ClickHouse, Kafka, portfolio hardening, and stable MVP |

## CI and image releases

GitHub Actions runs the complete PostgreSQL-backed test suite for pull requests, pushes to `main`, and version tags. Pushing a tag such as `v0.2.0` also publishes `ghcr.io/<owner>/incidentiq-api:v0.2.0` and `latest` to GitHub Container Registry.

No registry credential needs to be created: the release job uses GitHub's built-in token with `packages: write` permission. Create and push a version tag after the feature is merged:

```sh
git tag v0.2.0
git push origin v0.2.0
```
