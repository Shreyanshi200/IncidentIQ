import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { NormalizedEvent } from "@incidentiq/event-schema";
import type { IncidentIQClient } from "@incidentiq/node-sdk";

export function createDemoFailureEvent(message: string, now = new Date()): NormalizedEvent {
  return {
    event_id: randomUUID(),
    occurred_at: now.toISOString(),
    received_at: now.toISOString(),
    tenant_id: "local",
    environment: "local",
    service: "demo-orders",
    source: "node_sdk",
    event_type: "database_timeout",
    severity: "error",
    attributes: { message }
  };
}

export function createDemoService(incidentiq: IncidentIQClient): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/orders" && url.searchParams.get("fail") === "true") {
      incidentiq.track(createDemoFailureEvent("Demo database timeout"));
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Database temporarily unavailable" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ orders: [] }));
  });
}
