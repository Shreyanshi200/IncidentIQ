# IncidentIQ

[![CI](https://github.com/Shreyanshi200/IncidentIQ/actions/workflows/ci.yml/badge.svg)](https://github.com/Shreyanshi200/IncidentIQ/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1.svg)](https://www.postgresql.org/)

<p align="center">
  <img src="assets/incidentiq-iq.png" alt="Abstract illustration of application, deployment, and infrastructure signals flowing into an IncidentIQ evidence graph" width="960">
</p>

**IncidentIQ is an evidence-first incident intelligence platform.** It keeps application failures, deployments, and Kubernetes workload failures together, so an engineer can see what changed and what failed when investigating an incident.

## The problem

When a production service breaks, the useful clues are usually scattered: an error appears in one place, a deployment happened somewhere else, and Kubernetes reports failures in another tool. Connecting those clues manually is slow and makes it easy to miss the real cause.

## How IncidentIQ helps

IncidentIQ accepts those operational signals, stores them safely in PostgreSQL, removes configured secret fields, and lets you inspect a time-ordered evidence trail. Today you can send application events, GitHub deployment context, and read-only Kubernetes workload-failure signals. The local CLI is the investigation interface while the web dashboard is planned.

## Start locally

This is the quickest way to run IncidentIQ on your computer. It starts PostgreSQL in Docker and runs the API from this repository.

### What you need

- Git
- Node.js 24 or newer
- pnpm 11.6
- Docker Desktop (running)

If `pnpm` is not available on your machine, install the repository-pinned version with `npm install --global pnpm@11.6.0`.

### 1. Download the project

```sh
git clone https://github.com/Shreyanshi200/IncidentIQ.git
```

```sh
cd IncidentIQ
```

### 2. Install project dependencies

```sh
pnpm install --frozen-lockfile
```

### 3. Configure the local database

Create your local environment file:

```sh
cp .env.example .env
```

For local use, `.env` already contains a working database address:

```text
DATABASE_URL=postgresql://incidentiq:incidentiq@localhost:5432/incidentiq
```

Start PostgreSQL:

```sh
docker compose up -d postgres
```

### 4. Prepare IncidentIQ and create a key

Create the database tables:

```sh
pnpm incidentiq init
```

Create an ingestion key:

```sh
pnpm incidentiq keys create --scope ingest
```

The key command prints an `iiq_...` key only once. Save it in a password manager or secret manager. Never commit it to Git or place it directly in a workflow file.

### 5. Run the API

```sh
pnpm api
```

The API now listens at `http://localhost:3000`. Keep this terminal open.

### 6. Check that it works

Open a second terminal in the project folder and check the API:

```sh
pnpm incidentiq api health
```

Expected response:

```json
{"status":"ok"}
```

See the events stored in your local database:

```sh
pnpm incidentiq events list
```

The event list is newest first. It reads PostgreSQL directly, so it still works if the API process is stopped.

## Send your first signals

Choose the type of evidence you want to connect first:

| You want to record | Start here |
| --- | --- |
| An application error from a Node.js service | [Node.js SDK integration](docs/integrations/node-sdk.md) |
| A deployment from a GitHub Actions workflow | [GitHub Actions integration](docs/integrations/github-actions.md) |
| Pod restarts, crashes, or scheduling failures in one Kubernetes namespace | [Kubernetes workload collector](docs/integrations/kubernetes-collector.md) |
| Sample data to explore investigation and correlation output | [Load a fixture](#try-an-investigation-with-sample-data) |

For a remote API, the producer needs the API's HTTPS URL and the `iiq_...` ingestion key created above. Keep both in its environment or secret manager—not in source code.

## What is available today

- Authenticated event ingestion at `POST /v1/events/batch`
- PostgreSQL event storage, duplicate-event protection, and configured secret-field redaction
- A local CLI for inspecting stored events and deterministic sample investigations
- A fail-open Node.js SDK implementation for application events
- A GitHub Action for deployment context that does not fail a deployment if IncidentIQ is unavailable
- A namespace-scoped, read-only Kubernetes collector with reconnecting Pod, Event, Deployment, and Job watches

Not included yet: a web dashboard, automatic incident creation, cluster-wide Kubernetes collection, or a published npm SDK package. See the roadmap for what comes next.

## Try an investigation with sample data

Use this after the local setup above. A fixture is a small, known set of example events, useful for learning how IncidentIQ groups evidence without connecting a real service.

Validate the included deployment example:

```sh
pnpm incidentiq fixture validate demo/fixtures/deployment-regression.json
```

Load its events into your local database:

```sh
pnpm incidentiq fixture load demo/fixtures/deployment-regression.json
```

See the likely causes and evidence timeline:

```sh
pnpm incidentiq correlate demo/fixtures/deployment-regression.json
```

Save the investigation result:

```sh
pnpm incidentiq correlate demo/fixtures/deployment-regression.json --save
```

List saved investigations:

```sh
pnpm incidentiq incidents list
```

Explain one saved investigation:

```sh
pnpm incidentiq incidents explain deployment-regression
```

Export it as JSON:

```sh
pnpm incidentiq incidents export deployment-regression --format json
```

Loading the same fixture more than once does not duplicate its source events. Correlation returns an evidence timeline, ranked causes, score factors, and suggested next checks.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | A more detailed self-hosted setup, key creation, and troubleshooting |
| [GitHub Actions integration](docs/integrations/github-actions.md) | Recording real deployment metadata from a GitHub workflow |
| [Node.js SDK integration](docs/integrations/node-sdk.md) | Adding application error events and understanding current SDK packaging |
| [Kubernetes workload collector](docs/integrations/kubernetes-collector.md) | Installing and testing the read-only namespace collector |
| [Event data guide](docs/event-data.md) | Understanding which fields are generated, configured, or supplied by an integration |

## Build and test the project

Build all packages:

```sh
pnpm build
```

Run the automated tests:

```sh
pnpm test
```

Tests need PostgreSQL. If you followed the local setup, the Docker database is already available.

## Container images

After a change is merged to `main` and CI succeeds, GitHub publishes these images to GitHub Container Registry:

- `ghcr.io/<owner>/incidentiq-api:latest`
- `ghcr.io/<owner>/incidentiq-kubernetes-collector:latest`

For a deployment, prefer the immutable image created for one merge:

```sh
docker pull ghcr.io/<owner>/incidentiq-api:sha-<commit-sha>
```

```sh
docker pull ghcr.io/<owner>/incidentiq-kubernetes-collector:sha-<commit-sha>
```

The API image runs the API only. At this stage, use a source checkout and the CLI for database setup, creating ingestion keys, and inspecting events.

## Release roadmap

| Version | Status | Outcome |
| --- | --- | --- |
| 0.0.1 | Complete | Versioned contracts and canonical fixtures |
| 0.0.2 | Complete | PostgreSQL migrations and idempotent event storage |
| 0.0.3 | Complete | Deterministic cause ranking |
| 0.0.4 | Complete | Readable local investigation CLI |
| 0.1.0 | Complete | Authenticated event-ingestion API |
| 0.2.0 | Complete | Safe Node.js SDK implementation with batched, fail-open export |
| 0.3.0 | Complete | GitHub Actions deployment context |
| 0.4.0 | Complete | Read-only Kubernetes workload signals |
| 0.4.1 | In development | Checkpointed Pod, Deployment, and Job watches with curated reliability signals |
| 0.4.2 | Planned | Read-only Prometheus CPU, memory, latency, and error-rate evidence |
| 0.5.0 | Planned | Automatic incident detection and unified timeline |
| 0.6.0 | Planned | Single-operator dashboard: services, environments, integration setup, and local configuration |
| 0.6.1 | Planned | Dashboard investigations: incident list, evidence timeline, signal filters, and integration health |
| 0.7.0 | Planned | Evidence-bounded AI explanations and suggested next investigation steps |
| 0.8.0 | Planned | Operational polish: retention, safer API-key handling, and cost controls |
| 0.9.0 | Planned | ClickHouse for scalable historical event storage and investigations |
| 0.9.1 | Planned | Kafka-based streaming ingestion for high-volume, near-real-time evidence |
| 1.0.0 | Planned | Stable single-operator MVP with clear setup, reliable integrations, and documented operating guidance |

## Future extensibility

IncidentIQ is intentionally starting as a single-operator product. If it later needs to support teams or a managed offering, the architecture can be extended with:

- multi-user authentication, tenants, roles, and audit history;
- incident acknowledgement, assignment, resolution, and time-bounded suppression rules;
- notifications and integrations with Slack, PagerDuty, Jira, or similar tools;
- managed collector configuration, API-key rotation, and organization-wide policies; and
- cluster-wide Kubernetes and multi-cluster collection.

These are future expansion paths, not commitments for the current MVP.
