# Getting started

This guide starts a local, self-hosted IncidentIQ installation. It is the supported setup path for the current version.

## Requirements

- Node.js 24 or newer
- pnpm 11.6
- Docker Desktop, for PostgreSQL

If `pnpm` is not installed, run `npm install --global pnpm@11.6.0`.

## 1. Install and configure

```sh
git clone https://github.com/Shreyanshi200/IncidentIQ.git
```

```sh
cd IncidentIQ
```

```sh
pnpm install --frozen-lockfile
```

Build the workspace once. Normal `pnpm incidentiq ...` commands then run immediately without rebuilding every package:

```sh
pnpm build
```

```sh
cp .env.example .env
```

```sh
docker compose up -d postgres
```

After changing source code, use `pnpm incidentiq:dev ...` when you want to rebuild the CLI and its workspace dependencies before running a command.

The default `.env` configures a local database:

```text
DATABASE_URL=postgresql://incidentiq:incidentiq@localhost:5432/incidentiq
INCIDENTIQ_INCIDENT_GAP_MINUTES=10
INCIDENTIQ_CONTEXT_LOOKBACK_MINUTES=10
```

For a deployed API, replace the database URL with the PostgreSQL connection string supplied by your hosting environment. Keep it secret. The two incident settings accept positive minute values: the gap controls when matching evidence starts a new incident, while the lookback controls how far before the incident IncidentIQ searches for context and correlation evidence.

## 2. Initialise the database and create an ingestion key

```sh
pnpm incidentiq init
```

```sh
pnpm incidentiq keys create --scope ingest --tenant local --label local-ingestion
```

The first command applies the PostgreSQL migrations. The second prints an `iiq_...` ingestion key once; IncidentIQ stores its hash, not the raw key.

Save the raw key in your application or CI secret manager before closing the terminal. The command explicitly creates it for the `local` tenant, so integrations should use `tenant-id: local`. Follow the [operations guide](operations.md) to list, rotate, expire, and revoke keys safely.

## 3. Run the API

```sh
pnpm api
```

The API listens on `http://localhost:3000`. In another terminal, confirm it can reach PostgreSQL:

```sh
pnpm incidentiq api health
```

Expected output:

```json
{"status":"ok"}
```

## 4. Inspect stored evidence

```sh
pnpm incidentiq events list
```

The output is JSON, newest event first. An event is saved only when its `tenant_id` matches the ingestion key's tenant and it passes the shared event-schema validation.

## 5. Connect a producer

Choose an integration:

- [GitHub Actions](integrations/github-actions.md) for deployment context.
- [Node.js SDK](integrations/node-sdk.md) for application events.
- [Kubernetes collector](integrations/kubernetes-collector.md) for read-only workload failures.
- [Prometheus Alertmanager](integrations/alertmanager.md) for production alert delivery from your existing alert rules.

## 6. See automatic incident detection

New `error` and `critical` events accepted by the API automatically open or enrich an incident. Follow the [automatic incidents guide](automatic-incidents.md) for a copyable local test and the current grouping rules.

## 7. Run the local dashboard

The dashboard is a separate browser application. It requires its own read-only key, not the ingestion key used by integrations. Follow the [dashboard guide](dashboard.md) to create the key and open the local UI.

## 8. Optional AI explanations

The dashboard works without AI. To add operator-requested, evidence-bounded explanations, configure your own OpenAI API key and model on the API server, then restart it. Follow the [AI explanations guide](ai-explanations.md) for the exact values, data boundary, four-scenario test pack, and verification steps.

## Production notes

The API needs a PostgreSQL database and must be reachable over HTTPS by remote producers such as GitHub-hosted runners. Use the [production API deployment guide](deployment/api-production.md) for a repeatable Docker, reverse-proxy, backup, and upgrade setup.

The API and Kubernetes collector images are published to GitHub Container Registry after CI succeeds for a change on `main`. Each publish creates a moving `latest` tag and an immutable `sha-<commit SHA>` tag. Prefer the immutable tag in a real deployment.
