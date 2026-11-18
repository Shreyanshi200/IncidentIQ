# Automatic incidents

IncidentIQ now turns live ingestion into an investigation automatically. It is intentionally a small first version: one open incident groups nearby evidence for one tenant, service, and environment.

## What opens an incident

Every newly accepted event is evaluated inside the same database transaction that stores it.

- An event with severity `error` or `critical` opens an incident when no nearby incident exists.
- An event arriving within ten minutes of an open incident for the same tenant, service, and environment enriches that incident's timeline.
- The new incident includes matching service events from the preceding ten minutes. This lets a deployment be visible beside the error that followed it.
- `info` and `warning` events do not open incidents by themselves. They can still enrich a nearby open incident.

Incident IDs begin with `auto_`. The timeline is ordered by its event occurrence time and is stored with the incident, along with the current evidence-based cause ranking.

## Local test

Complete the [getting-started setup](getting-started.md) first. The API must be running and you need an `iiq_...` ingestion key.

In a second terminal, set the values for your local API and key:

```sh
export INCIDENTIQ_API_URL=http://localhost:3000
```

```sh
export INCIDENTIQ_API_KEY='iiq_replace_with_your_key'
```

Create a unique test suffix and current timestamp:

```sh
export INCIDENTIQ_TEST_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
```

```sh
export INCIDENTIQ_OCCURRED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

```sh
export INCIDENTIQ_SERVICE="orders-$INCIDENTIQ_TEST_ID"
```

Send a deployment and an application error for the same service. The deployment is context; the error opens the incident.

```sh
curl --fail-with-body "$INCIDENTIQ_API_URL/v1/events/batch" \
  --header "Authorization: Bearer $INCIDENTIQ_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"events\":[{\"event_id\":\"local-deployment-$INCIDENTIQ_TEST_ID\",\"occurred_at\":\"$INCIDENTIQ_OCCURRED_AT\",\"tenant_id\":\"local\",\"environment\":\"local\",\"service\":\"$INCIDENTIQ_SERVICE\",\"source\":\"github_actions\",\"event_type\":\"deployment\",\"severity\":\"info\",\"version\":\"local-test\",\"attributes\":{\"state\":\"success\"}},{\"event_id\":\"local-error-$INCIDENTIQ_TEST_ID\",\"occurred_at\":\"$INCIDENTIQ_OCCURRED_AT\",\"tenant_id\":\"local\",\"environment\":\"local\",\"service\":\"$INCIDENTIQ_SERVICE\",\"source\":\"node_sdk\",\"event_type\":\"exception\",\"severity\":\"error\",\"version\":\"local-test\",\"attributes\":{\"message\":\"local incident test\"}}]}"
```

Expected response:

```json
{"accepted":2,"duplicates":0}
```

List incidents from the repository root:

```sh
pnpm incidentiq incidents list
```

You should see a new `auto_...` incident for your unique `orders-...` service. Copy its ID, then see its saved timeline and cause ranking:

```sh
pnpm incidentiq incidents explain auto_replace_with_the_listed_id
```

The command prints the unified timeline, ranked causes, evidence factors, and suggested checks. You can also export the same stored investigation:

```sh
pnpm incidentiq incidents export auto_replace_with_the_listed_id --format json
```

## Current boundaries

- Automatic detection runs only for events received by the API. `pnpm incidentiq fixture load ...` intentionally writes demo events directly to PostgreSQL and does not create automatic incidents.
- Grouping is local to a tenant, service, and environment. Cross-service incident merging and dependency graphs remain future work.
- Incidents stay `open`; acknowledgement, resolution, and notification workflow are planned after the dashboard foundation.
