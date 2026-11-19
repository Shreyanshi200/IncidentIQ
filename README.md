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

IncidentIQ accepts those operational signals, stores them safely in PostgreSQL, removes configured secret fields, and lets you inspect a time-ordered evidence trail. Today you can send application events, GitHub deployment context, read-only Kubernetes workload-failure signals, and Prometheus alerts delivered by Alertmanager. The CLI investigates individual incidents, while the dashboard shows operational coverage and provides filtered, evidence-backed incident investigations.

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
| Pod, Deployment, or Job failures in one Kubernetes namespace | [Kubernetes workload collector](docs/integrations/kubernetes-collector.md) |
| Prometheus reliability alerts from Alertmanager | [Prometheus Alertmanager integration](docs/integrations/alertmanager.md) |
| Sample data to explore investigation and correlation output | [Load a fixture](#try-an-investigation-with-sample-data) |

For a remote API, the producer needs the API's HTTPS URL and the `iiq_...` ingestion key created above. Keep both in its environment or secret manager—not in source code.

## What is available today

- Authenticated event ingestion at `POST /v1/events/batch`
- PostgreSQL event storage, duplicate-event protection, and configured secret-field redaction
- A local CLI for inspecting stored events and deterministic sample investigations
- A fail-open Node.js SDK implementation for application events
- A GitHub Action for deployment context that does not fail a deployment if IncidentIQ is unavailable
- A namespace-scoped, read-only Kubernetes collector with reconnecting Pod, Event, Deployment, and Job watches
- Alertmanager webhook ingestion for Prometheus CPU, memory, latency, and error-rate alerts
- Automatic incident creation for new error and critical signals, with nearby service evidence saved as one timeline
- A separate React dashboard with focused Overview and Investigations views, evidence-backed briefs, candidate rankings, contextual next checks, readable timelines, navigable PDF incident reports, and evidence-source activity

Not included yet: incident acknowledgement or resolution workflow, cluster-wide Kubernetes collection, or AI-generated explanations. See the roadmap for what comes next.

## Product tour

These screenshots use the included production-like checkout fixture, which combines deployment, application, Kubernetes, Alertmanager, rollback, and recovery evidence in one investigation.

### 1. Start a secure browser session

<p align="center">
  <img src="assets/screenshots/dashboard-login.png" alt="IncidentIQ dashboard login screen requesting a read-only API key" width="960">
</p>

<p align="center"><sub>Use a read-only API key once to create an eight-hour browser session. The dashboard does not store the raw key.</sub></p>

### 2. Review operational coverage

<p align="center">
  <img src="assets/screenshots/dashboard-overview.png" alt="IncidentIQ operational coverage dashboard showing services, environments, and evidence-source activity" width="960">
</p>

<p align="center"><sub>See which services, environments, and integrations are contributing evidence.</sub></p>

### 3. Browse incident investigations

<p align="center">
  <img src="assets/screenshots/investigations.png" alt="IncidentIQ investigation list with service, environment, source filters, confidence, and evidence counts" width="960">
</p>

<p align="center"><sub>Filter saved incidents and choose one to inspect.</sub></p>

### 4. Inspect one incident

<p align="center">
  <img src="assets/screenshots/investigation-detail-highlights.png" alt="IncidentIQ investigation showing the incident brief, linked evidence, confidence, and compact evidence highlights" width="960">
</p>

<p align="center"><sub>Review the leading hypothesis, observed scope, and the exact evidence that influenced its ranking.</sub></p>

### 5. Review the recommended next checks

<p align="center">
  <img src="assets/screenshots/recommended-next-steps.png" alt="IncidentIQ validation plan with evidence-based recommended next checks followed by the ordered evidence timeline" width="960">
</p>

<p align="center"><sub>Use the evidence-based validation plan before choosing a remediation.</sub></p>

### 6. Follow what IncidentIQ recorded

<p align="center">
  <img src="assets/screenshots/evidence-timeline.png" alt="IncidentIQ ordered evidence timeline showing deployment, Kubernetes, application error, and Alertmanager events with plain-language explanations" width="960">
</p>

<p align="center"><sub>Follow the evidence in time order, with readable explanations and expandable raw attributes.</sub></p>

### 7. Download the incident report

<p align="center">
  <img src="assets/screenshots/incident-report.png" alt="IncidentIQ PDF incident report showing candidate ranking and supporting observations" width="620">
</p>

<p align="center"><sub>Download a navigable PDF containing the ranked candidates, supporting and counterevidence, validation plan, and complete evidence timeline.</sub></p>

## Local dashboard

The dashboard is a separate app in `apps/dashboard`; the API remains responsible only for authenticated data. A read-only `iiq_...` key starts an eight-hour session backed by an `HttpOnly`, same-site cookie. The raw key is never stored by the dashboard, and an ingestion key cannot open it.

Follow the [dashboard guide](docs/dashboard.md) to start it locally.

Create its separate read-only key:

```sh
pnpm incidentiq keys create --scope read
```

Then start the browser app:

```sh
pnpm dashboard
```

## Automatic incidents

When the API accepts an `error` or `critical` event, IncidentIQ opens an incident or adds the event to a nearby open incident for the same tenant, service, and environment. By default, matching evidence is grouped across a ten-minute activity gap and the preceding ten minutes are included as context. Configure these independently with `INCIDENTIQ_INCIDENT_GAP_MINUTES` and `INCIDENTIQ_CONTEXT_LOOKBACK_MINUTES`.

Start with the [automatic incidents guide](docs/automatic-incidents.md) to test this locally and understand its current grouping rules.

## Try an investigation with sample data

Use this after the local setup above. A fixture is a small, known set of example events, useful for learning how IncidentIQ groups evidence without connecting a real service.

Validate the included production-like checkout incident. It contains 20 deployment, application, alert, Kubernetes, rollback, and recovery events:

```sh
pnpm incidentiq fixture validate demo/fixtures/production-checkout-regression.json
```

Load its events into your local database:

```sh
pnpm incidentiq fixture load demo/fixtures/production-checkout-regression.json
```

See the likely causes and evidence timeline:

```sh
pnpm incidentiq correlate demo/fixtures/production-checkout-regression.json
```

Save the investigation result:

```sh
pnpm incidentiq correlate demo/fixtures/production-checkout-regression.json --save
```

List saved investigations:

```sh
pnpm incidentiq incidents list
```

Explain one saved investigation:

```sh
pnpm incidentiq incidents explain production-checkout-regression
```

Export it as JSON:

```sh
pnpm incidentiq incidents export production-checkout-regression --format json
```

Loading the same fixture more than once does not duplicate its source events. Correlation returns an evidence timeline, ranked causes, score factors, and contextual next checks. Saving it also links every fixture event to the dashboard investigation.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | A more detailed self-hosted setup, key creation, and troubleshooting |
| [Production API deployment](docs/deployment/api-production.md) | Running the API behind HTTPS with PostgreSQL, backups, and an upgrade procedure |
| [GitHub Actions integration](docs/integrations/github-actions.md) | Recording real deployment metadata from a GitHub workflow |
| [Node.js SDK integration](docs/integrations/node-sdk.md) | Installing the npm SDK and sending application error events |
| [Kubernetes workload collector](docs/integrations/kubernetes-collector.md) | Installing and testing the read-only namespace collector |
| [Prometheus Alertmanager integration](docs/integrations/alertmanager.md) | Recording firing and resolved Prometheus alerts through Alertmanager webhooks |
| [Automatic incidents](docs/automatic-incidents.md) | Seeing how live error and critical signals open and enrich a saved evidence timeline |
| [Dashboard](docs/dashboard.md) | Running or deploying the authenticated coverage and incident-investigation interface |
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

The API image starts the API by default. It also includes the IncidentIQ CLI, so an operator can apply migrations and create ingestion keys without installing Node.js on the server. See [Production API deployment](docs/deployment/api-production.md) for the complete setup.

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
| 0.4.1 | Complete | Checkpointed Pod, Deployment, and Job watches with curated reliability signals |
| 0.4.2 | Complete | Production-oriented Alertmanager ingestion for Prometheus reliability alerts |
| 0.5.0 | Complete | Public Node.js SDK: npm packages, trusted publishing, and external-install verification |
| 0.6.0 | Complete | Automatic incident detection and unified timeline |
| 0.7.0 | Complete | Single-operator dashboard: services, environments, integration setup, and local configuration |
| 0.7.1 | Complete | Dashboard investigations: evidence-backed brief, candidate ranking, contextual next checks, readable timeline, report download, pagination, filters, and evidence-source activity |
| 0.8.0 | Planned | Evidence-bounded AI explanations and suggested next investigation steps |
| 0.8.1 | Planned | Operational polish: safer API-key handling, retention, and cost controls |
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
