# @incidentiqhq/node-sdk

The Node.js client for sending application evidence to a self-hosted IncidentIQ API.

```sh
npm install @incidentiqhq/node-sdk
```

```ts
import { randomUUID } from "node:crypto";
import { createIncidentIQ } from "@incidentiqhq/node-sdk";

const incidentiq = createIncidentIQ({
  apiKey: process.env.INCIDENTIQ_API_KEY!,
  apiUrl: process.env.INCIDENTIQ_API_URL
});

incidentiq.track({
  event_id: randomUUID(),
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

process.once("SIGTERM", () => void incidentiq.shutdown());
process.once("SIGINT", () => void incidentiq.shutdown());
```

The SDK batches events and fails open when the API is unavailable, so it does not fail your application requests. See the [full integration guide](https://github.com/Shreyanshi200/IncidentIQ/blob/main/docs/integrations/node-sdk.md) for setup and delivery limits.
