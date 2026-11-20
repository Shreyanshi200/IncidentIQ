import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApiKeysService } from "../src/api-keys.service.js";
import { normalizeAlertmanagerWebhook } from "../src/alertmanager.service.js";
import { createApp } from "../src/app.js";
import { DatabaseService } from "../src/database.js";
import { clearTestTenants } from "./database-cleanup.js";

const databaseUrl = process.env.DATABASE_URL;

test("ingestion accepts, redacts, deduplicates, and rejects invalid batches", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  const tenant = `test-${randomUUID()}`;
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const apiKey = (await app.get(ApiKeysService).create("ingest", tenant)).key;
    const event = {
      event_id: `api-test-${randomUUID()}`,
      occurred_at: "2026-10-23T12:00:00.000Z",
      tenant_id: tenant,
      environment: "local",
      service: "orders",
      source: "node_sdk",
      event_type: "exception",
      severity: "error",
      attributes: { authorization: "secret", message: "database error" }
    };
    const request = (body: unknown, authorization?: string) => fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body)
    });

    assert.equal((await request({ events: [event] })).status, 401);
    assert.equal((await request({ events: [{}] }, `Bearer ${apiKey}`)).status, 400);
    assert.deepEqual(await (await request({ events: [event] }, `Bearer ${apiKey}`)).json(), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await (await request({ events: [event] }, `Bearer ${apiKey}`)).json(), { accepted: 0, duplicates: 1 });
    const stored = await app.get(DatabaseService).db.selectFrom("source_events").select("attributes").where("event_id", "=", event.event_id).executeTakeFirstOrThrow();
    assert.deepEqual(stored.attributes, { authorization: "[REDACTED]", message: "database error" });

    const alertPayload = {
      version: "4",
      alerts: [{
        status: "firing",
        labels: { alertname: "HighLatency", severity: "critical", service: "orders", namespace: "payments", incidentiq_signal: "latency_spike" },
        annotations: { summary: "p95 latency is above one second" },
        startsAt: "2026-10-30T08:00:00.000Z",
        fingerprint: randomUUID()
      }]
    };
    const alertRequest = (authorization?: string) => fetch(`${baseUrl}/v1/integrations/alertmanager`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(alertPayload)
    });
    assert.equal((await alertRequest()).status, 401);
    assert.deepEqual(await (await alertRequest(`Bearer ${apiKey}`)).json(), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await (await alertRequest(`Bearer ${apiKey}`)).json(), { accepted: 0, duplicates: 1 });
    const alert = normalizeAlertmanagerWebhook(alertPayload, tenant)[0]!;
    const storedAlert = await app.get(DatabaseService).db.selectFrom("source_events").select(["source", "event_type", "resource"]).where("event_id", "=", alert.event_id).executeTakeFirstOrThrow();
    assert.deepEqual(storedAlert, { source: "alertmanager", event_type: "latency_spike", resource: "service/payments/orders" });
  } finally {
    await clearTestTenants(app.get(DatabaseService), tenant);
    await app.close();
  }
});
