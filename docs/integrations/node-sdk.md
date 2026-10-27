# Node.js SDK integration

The Node.js SDK batches normalized application events and fails open: it does not throw when IncidentIQ cannot receive telemetry. Your application continues to serve its own requests.

## Current packaging status

`@incidentiq/node-sdk` is currently a workspace package in this repository. It is exercised by [`apps/demo-service`](../../apps/demo-service), but it is **not yet published as an installable npm package**. Do not document `npm install @incidentiq/node-sdk` for external users until package publishing is added.

The integration shape below is the public API that will be used once the package is published. For now, use the demo service as the runnable reference or consume the package from this workspace.

## Initialise the client

```ts
import { randomUUID } from "node:crypto";
import { createIncidentIQ } from "@incidentiq/node-sdk";

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
| On API failure | Requeues the batch; the oldest queued events are dropped only when the queue reaches its limit |
| API endpoint | `POST /v1/events/batch` with a bearer ingestion key |

The API overwrites `received_at` when it accepts an event, so that field represents the server's receipt time. The client-provided `occurred_at` remains the event's observed time.

## Run the included demo

From the repository root, start PostgreSQL and the API as shown in [Getting started](../getting-started.md). Then run the demo with your generated key:

```sh
INCIDENTIQ_API_KEY=iiq_your_key pnpm demo-service
```

In another terminal:

```sh
curl -i "http://localhost:4000/orders?fail=true"
pnpm incidentiq events list
```

The demo returns `503` to simulate its own database problem, while IncidentIQ independently records the evidence event.
