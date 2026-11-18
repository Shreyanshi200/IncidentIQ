# @incidentiqhq/event-schema

The shared TypeScript event contract for IncidentIQ producers and integrations.

Most Node.js applications only need [`@incidentiqhq/node-sdk`](https://www.npmjs.com/package/@incidentiqhq/node-sdk). Install this package directly when you are writing a custom IncidentIQ producer or need the `NormalizedEvent` type.

```sh
npm install @incidentiqhq/event-schema
```

```ts
import { validateEvent, type NormalizedEvent } from "@incidentiqhq/event-schema";

const event: NormalizedEvent = {
  event_id: crypto.randomUUID(),
  occurred_at: new Date().toISOString(),
  received_at: new Date().toISOString(),
  tenant_id: "local",
  environment: "production",
  service: "orders",
  source: "node_sdk",
  event_type: "exception",
  severity: "error",
  attributes: { message: "database timeout" }
};

console.log(validateEvent(event));
```

See the [IncidentIQ event data guide](https://github.com/Shreyanshi200/IncidentIQ/blob/main/docs/event-data.md) for the complete contract.
