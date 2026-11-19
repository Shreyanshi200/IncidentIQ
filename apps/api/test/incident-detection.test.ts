import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApiKeysService } from "../src/api-keys.service.js";
import { createApp } from "../src/app.js";
import { DatabaseService } from "../src/database.js";
import { configuredWindowMs } from "../src/incident-detection.service.js";

const databaseUrl = process.env.DATABASE_URL;

test("incident window settings use validated minute values", () => {
  assert.equal(configuredWindowMs(undefined, "WINDOW"), 10 * 60 * 1000);
  assert.equal(configuredWindowMs("2.5", "WINDOW"), 2.5 * 60 * 1000);
  assert.throws(() => configuredWindowMs("0", "WINDOW"), /WINDOW must be a positive number of minutes/);
  assert.throws(() => configuredWindowMs("not-a-number", "WINDOW"), /WINDOW must be a positive number of minutes/);
});

test("error signals create one incident with nearby timeline evidence", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const tenant = `test-${randomUUID()}`;
    const apiKey = (await app.get(ApiKeysService).create("ingest", tenant)).key;
    const suffix = randomUUID();
    const service = `orders-${suffix}`;
    const request = await fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        events: [
          {
            event_id: `deploy-${suffix}`,
            occurred_at: "2026-11-18T10:00:00.000Z",
            tenant_id: tenant,
            environment: "test",
            service,
            source: "github_actions",
            event_type: "deployment",
            severity: "info",
            version: "1.2.3",
            attributes: { state: "success" }
          },
          {
            event_id: `error-${suffix}`,
            occurred_at: "2026-11-18T10:02:00.000Z",
            tenant_id: tenant,
            environment: "test",
            service,
            source: "node_sdk",
            event_type: "database_timeout",
            severity: "critical",
            version: "1.2.3",
            attributes: { message: "connection refused" }
          },
          {
            event_id: `restart-${suffix}`,
            occurred_at: "2026-11-18T10:03:00.000Z",
            tenant_id: tenant,
            environment: "test",
            service,
            source: "kubernetes",
            event_type: "pod_restart",
            severity: "warning",
            attributes: { restarts: 1 }
          }
        ]
      })
    });

    assert.deepEqual(await request.json(), { accepted: 3, duplicates: 0 });
    const database = app.get(DatabaseService).db;
    const incident = await database
      .selectFrom("incidents")
      .select(["incident_id", "event_count", "leading_cause", "confidence", "investigation"])
      .where("service", "=", service)
      .executeTakeFirstOrThrow();
    assert.equal(incident.event_count, 3);
    assert.equal(incident.leading_cause, "deployment_regression");
    assert.equal(incident.confidence, "high");
    const investigation = incident.investigation as { correlation_window_ms: number; timeline: Array<{ event_id: string }> };
    assert.equal(investigation.correlation_window_ms, 10 * 60 * 1000);
    assert.deepEqual(investigation.timeline.map((event) => event.event_id), [`deploy-${suffix}`, `error-${suffix}`, `restart-${suffix}`]);
    const evidence = await database.selectFrom("incident_events").select("event_id").where("incident_id", "=", incident.incident_id).orderBy("event_id").execute();
    assert.deepEqual(evidence.map((event) => event.event_id).sort(), [`deploy-${suffix}`, `error-${suffix}`, `restart-${suffix}`].sort());
  } finally {
    await app.close();
  }
});

test("informational evidence does not open an incident", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const tenant = `test-${randomUUID()}`;
    const apiKey = (await app.get(ApiKeysService).create("ingest", tenant)).key;
    const service = `catalog-${randomUUID()}`;
    const request = await fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        events: [{
          event_id: `deploy-${service}`,
          occurred_at: "2026-11-18T10:00:00.000Z",
          tenant_id: tenant,
          environment: "test",
          service,
          source: "github_actions",
          event_type: "deployment",
          severity: "info",
          attributes: { state: "success" }
        }]
      })
    });

    assert.deepEqual(await request.json(), { accepted: 1, duplicates: 0 });
    const incident = await app.get(DatabaseService).db.selectFrom("incidents").select("incident_id").where("service", "=", service).executeTakeFirst();
    assert.equal(incident, undefined);
  } finally {
    await app.close();
  }
});
