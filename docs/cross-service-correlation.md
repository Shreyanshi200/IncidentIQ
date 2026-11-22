# Cross-service correlation

IncidentIQ stores automatic incidents per tenant, environment, and service. It does not delete or merge those records. When you inspect an incident, it can present a unified cross-service investigation when recorded evidence links nearby service-local incidents.

## What can create a link

All linked evidence must stay within the same tenant and environment and within the incident's configured correlation window.

IncidentIQ evaluates every service-local incident that overlaps that evidence window; it does not stop after a fixed incident count. Keep the correlation window no wider than the operational context you actually need so a broad outage does not make investigations unnecessarily expensive.

- **Shared trace:** error or critical evidence from different services has the same `trace_id`. For a trace crossing more than two services, IncidentIQ links adjacent failures in recorded time order instead of inventing every possible service-to-service edge.
- **Declared dependency:** an error or critical application event names another service in `attributes.dependency`, and that dependency has a preceding failure within the same evidence window.

The Analysis tab shows the exact link type and event buttons. A shared trace establishes that a request crossed services; it does not prove where the initiating fault occurred. A declared dependency establishes a recorded call relationship; it does not replace a service catalog or distributed tracing system.

## What stays separate

IncidentIQ does not link incidents merely because they occurred at the same time, share an environment, or have similar error text. Evidence from other tenants and environments is never considered. This prevents a broad outage from being presented as a single causal chain without proof.

## Test locally

Start PostgreSQL and the API using the [getting-started guide](getting-started.md). The prepared `production-payment-pool-cascade` fixture contains 40 events across checkout and payments, five shared failure traces, competing deployment and Kubernetes symptoms, an ineffective checkout rollback, a payments rollback, and recovery evidence.

Clear the disposable test tenant before replaying the fixed event IDs:

```sh
pnpm incidentiq data clear --tenant cross-service-test --confirm
```

Create an ingestion key for the disposable tenant:

```sh
pnpm incidentiq keys create --scope ingest --tenant cross-service-test --label cascade-test
```

Export the ingestion key printed by the create command:

```sh
read -rs INCIDENTIQ_API_KEY
export INCIDENTIQ_API_KEY
printf '\n'
```

Confirm that the key exists in this terminal. This does not print its value:

```sh
test -n "$INCIDENTIQ_API_KEY" && echo "Ingestion key is set" || echo "Ingestion key is missing"
```

Ingest the complete fixture through the real API and automatic incident-detection path:

```sh
pnpm incidentiq fixture ingest demo/fixtures/production-payment-pool-cascade.json --tenant cross-service-test
```

Expected result:

```text
Ingested production-payment-pool-cascade: 40 accepted, 0 duplicate.
```

Create a read key for the same tenant and use it to open the dashboard:

```sh
pnpm incidentiq keys create --scope read --tenant cross-service-test --label cascade-dashboard
```

Inspect either the `checkout-api` or `payments-api` production incident. Confirm that the unified investigation contains both services, shared-trace and declared-dependency links, the full ordered evidence, and a **Downstream timeout** leading hypothesis. The checkout rollback should appear as counterevidence because failures continue afterward; recovery should follow the payments rollback. Download the PDF and verify that it summarizes each service relationship once, while the dashboard retains exact cited events and raw attributes.

Confirm that the database still contains separate service-local incidents:

```sh
pnpm incidentiq incidents list --tenant cross-service-test
```

The automated API test adds stricter isolation checks that the reusable fixture does not need to encode: a three-service transitive path, repeated links, same-time unrelated production noise, same-trace staging evidence, and the same trace in another tenant must all be handled correctly.

## Run the larger stress scenario

Use this after the 40-event walkthrough when you want a deliberately difficult investigation. The `production-commerce-platform-cascade` fixture contains 86 events and remains within the API's 100-event batch limit. It includes:

- a five-hop path from PostgreSQL through orders, payments, checkout, and edge;
- a second PostgreSQL-to-inventory-to-checkout branch;
- five repeated end-to-end traces and two failed rollback attempts;
- competing checkout and inventory Kubernetes symptoms;
- unrelated fraud and notification failures that must not join the chain; and
- ordered recovery only after the database capacity configuration is restored.

Clear a separate disposable tenant:

```sh
pnpm incidentiq data clear --tenant cross-service-stress --confirm
```

Create its ingestion key:

```sh
pnpm incidentiq keys create --scope ingest --tenant cross-service-stress --label commerce-stress
```

Export the newly printed raw key in the same terminal:

```sh
read -rs INCIDENTIQ_API_KEY
export INCIDENTIQ_API_KEY
printf '\n'
```

Ingest all 86 events through the real API path:

```sh
pnpm incidentiq fixture ingest demo/fixtures/production-commerce-platform-cascade.json --tenant cross-service-stress
```

Expected result:

```text
Ingested production-commerce-platform-cascade: 86 accepted, 0 duplicate.
```

Create the matching dashboard key:

```sh
pnpm incidentiq keys create --scope read --tenant cross-service-stress --label commerce-stress-dashboard
```

Open the `postgres-primary`, `orders-api`, `payments-api`, `inventory-api`, `checkout-api`, or `edge-api` incident. They should resolve into one evidence-backed investigation with a **Downstream timeout** leading hypothesis and two visible propagation branches. The unrelated `fraud-api` incident must remain separate, and the notifications warning must not open an incident by itself. The checkout and payments rollbacks should not appear to resolve the outage; recovery begins only after `mega-postgres-restore`.

This is intentionally a stress fixture, not a benchmark or a claim that event count equals production realism. Its purpose is to test topology, noise rejection, counterevidence, dashboard compaction, PDF generation, and optional AI reasoning together.

If ingestion returns `401`, the raw key is not available to that terminal or is not an active `ingest` key for tenant `cross-service-test`. Create a new key and export it again; IncidentIQ stores only its hash and cannot recover a previously displayed secret.

## Current boundaries

- There is no inferred service catalog, topology import, or arbitrary graph search.
- Matching uses a bounded nearby-incident search, suitable for the supported single API process and PostgreSQL deployment.
- The dashboard joins related incidents at read time; it does not create a new durable parent incident.
- AI receives the same unified tenant-scoped timeline when you request a review. Its cache is invalidated when the linked evidence set changes.
