# Node.js SDK integration

The Node.js SDK batches normalized application events and fails open: it does not throw when IncidentIQ cannot receive telemetry. Your application continues to serve its own requests.

## Install

Install the public SDK in your Node.js service:

```sh
npm install @incidentiqhq/node-sdk
```

The package needs Node.js 24 or newer. It installs the shared event-schema package automatically. You still need a reachable, self-hosted IncidentIQ API and a valid ingestion key.

## Initialise the client

```ts
import { randomUUID } from "node:crypto";
import { createIncidentIQ } from "@incidentiqhq/node-sdk";

const incidentiq = createIncidentIQ({
  apiKey: process.env.INCIDENTIQ_API_KEY!,
  apiUrl: process.env.INCIDENTIQ_API_URL
});
```

`INCIDENTIQ_API_URL` is optional and defaults to `http://localhost:3000`. In a deployed service, provide the public IncidentIQ API base URL through configuration.

## Record an application error

```ts
incidentiq.track({
  event_id: randomUUID(),
  occurred_at: new Date().toISOString(),
  received_at: new Date().toISOString(),
  tenant_id: "local",
  environment: "production",
  service: "orders",
  source: "node_sdk",
  event_type: "database_timeout",
  severity: "error",
  attributes: { message: "database connection timed out" }
});
```

Call `track` beside the error handling that already knows the service, environment, event type, and safe diagnostic attributes. Do not include passwords, tokens, cookies, or full authorization headers.

Any Node SDK event with severity `error` or `critical` participates in application-failure correlation; `event_type` can describe the actual failure, such as `exception`, `database_timeout`, or `checkout_failed`.

## Flush during shutdown

```ts
process.once("SIGTERM", () => void incidentiq.shutdown());
process.once("SIGINT", () => void incidentiq.shutdown());
```

`shutdown()` flushes any queued events before the process exits. The included demo service follows this pattern.

## Defaults and behavior

| Behavior | Current value |
| --- | --- |
| Batch size | 100 events |
| Flush interval | 2 seconds |
| In-memory queue limit | 1,000 events |
| On API failure | Requeues the batch. The in-memory queue is bounded, so events can be lost during a prolonged API outage |
| API endpoint | `POST /v1/events/batch` with a bearer ingestion key |

The API overwrites `received_at` when it accepts an event, so that field represents the server's receipt time. The client-provided `occurred_at` remains the event's observed time.

## Run the included demo

From the repository root, start PostgreSQL and the API as shown in [Getting started](../getting-started.md). Then run the included demo with your generated key:

```sh
INCIDENTIQ_API_KEY=iiq_your_key pnpm demo-service
```

In another terminal:

```sh
curl -i "http://localhost:4000/orders?fail=true"
pnpm incidentiq events list
```

The demo returns `503` to simulate its own database problem, while IncidentIQ independently records the evidence event.

## Package release maintenance

The maintainers' [npm publishing guide](../maintainers/publish-npm-packages.md) explains how the packages are built, externally installed, and released through GitHub Actions.
