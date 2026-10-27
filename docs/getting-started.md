# Getting started

This guide starts a local, self-hosted IncidentIQ installation. It is the supported setup path for the current version.

## Requirements

- Node.js 24 or newer
- pnpm 11 (Corepack installs the repository-pinned version)
- Docker Desktop, for PostgreSQL

## 1. Install and configure

```sh
git clone https://github.com/Shreyanshi200/IncidentIQ.git
cd IncidentIQ
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
```

The default `.env` configures a local database:

```text
DATABASE_URL=postgresql://incidentiq:incidentiq@localhost:5432/incidentiq
```

For a deployed API, replace this with the PostgreSQL connection string supplied by your hosting environment. Keep it secret.

## 2. Initialise the database and create an ingestion key

```sh
pnpm incidentiq init
pnpm incidentiq keys create --scope ingest
```

The first command applies the PostgreSQL migrations. The second prints an `iiq_...` ingestion key once; IncidentIQ stores its hash, not the raw key.

Save the raw key in your application or CI secret manager before closing the terminal. In the current release, the CLI creates keys for the `local` tenant, so integrations should use `tenant-id: local`.

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

## Production notes

The API needs a PostgreSQL database and must be reachable over HTTPS by remote producers such as GitHub-hosted runners. The GitHub Action guide explains the required CI secret and URL.

The API and Kubernetes collector images are published to GitHub Container Registry after CI succeeds for a change on `main`. Each publish creates a moving `latest` tag and an immutable `sha-<commit SHA>` tag. The API image runs the API process only. Key provisioning and event inspection currently use the repository CLI; an operator therefore needs a source checkout with the same database connection string.
