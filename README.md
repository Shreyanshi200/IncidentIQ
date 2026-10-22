# IncidentIQ

Evidence-first production incident investigation, starting as a CLI and local demo.

```text
apps/cli/                       CLI commands and PostgreSQL access
apps/api/                       Authenticated NestJS ingestion API
packages/event-schema/          Versioned shared contracts
packages/correlation/           Deterministic, inspectable cause ranking
infrastructure/postgres/        Shared database migrations
demo/fixtures/                  Repeatable incident scenarios
```

## Version 0.1.0

The project is TypeScript on Node.js. It validates versioned contracts, ingests authenticated event batches through NestJS and Kysely, stores normalized events in PostgreSQL, and presents deterministic fixture investigations in a reviewer-friendly CLI.

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

## Release roadmap

| Version | Status | Outcome |
| --- | --- | --- |
| 0.0.1 | Complete | Versioned contracts and canonical fixtures |
| 0.0.2 | Complete | PostgreSQL migrations and idempotent event storage |
| 0.0.3 | Complete | Deterministic cause ranking |
| 0.0.4 | Complete | Readable local investigation CLI |
| 0.1.0 | Complete | Authenticated event-ingestion API |
| 0.2.0 | Next | Safe Node.js SDK with batched, fail-open export |
| 0.3.0 | Planned | GitHub Actions deployment context |
| 0.4.0 | Planned | Read-only Kubernetes workload signals |
| 0.5.0 | Planned | Automatic incident detection and unified timeline |
| 0.6.0 | Planned | Evidence-bounded AI explanation |
| 0.8.0 | Planned | Reliability, retention, quotas, and cost controls |
| 0.9.0-1.0.0 | Planned | ClickHouse, Kafka, portfolio hardening, and stable MVP |

## CI and image releases

GitHub Actions runs the complete PostgreSQL-backed test suite for pull requests, pushes to `main`, and version tags. Pushing a tag such as `v0.1.0` also publishes `ghcr.io/<owner>/incidentiq-api:v0.1.0` and `latest` to GitHub Container Registry.

No registry credential needs to be created: the release job uses GitHub's built-in token with `packages: write` permission. Create and push a version tag after the feature is merged:

```sh
git tag v0.1.0
git push origin v0.1.0
```
