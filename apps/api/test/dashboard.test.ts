import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApiKeysService } from "../src/api-keys.service.js";
import { createApp } from "../src/app.js";
import type { DashboardOverview } from "../src/dashboard.service.js";

const databaseUrl = process.env.DATABASE_URL;

test("dashboard exchanges a read key for a tenant-scoped secure session", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const apiKeys = app.get(ApiKeysService);
    const tenant = `test-${randomUUID()}`;
    const ingestionKey = (await apiKeys.create("ingest", tenant)).key;
    const readKey = (await apiKeys.create("read", tenant)).key;
    const service = `dashboard-${randomUUID()}`;
    const environment = `test-${randomUUID()}`;
    const secondaryEnvironment = `staging-${randomUUID()}`;
    const event = {
      event_id: `dashboard-event-${randomUUID()}`,
      occurred_at: "2026-11-18T10:00:00.000Z",
      tenant_id: tenant,
      environment,
      service,
      source: "github_actions",
      event_type: "deployment",
      severity: "info",
      attributes: { state: "success" }
    };

    const ingestion = await fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ingestionKey}` },
      body: JSON.stringify({ events: [event, { ...event, event_id: `dashboard-event-${randomUUID()}`, environment: secondaryEnvironment, occurred_at: "2026-11-18T10:01:00.000Z" }] })
    });
    assert.deepEqual(await ingestion.json(), { accepted: 2, duplicates: 0 });

    const missing = await fetch(`${baseUrl}/v1/dashboard/overview`);
    assert.equal(missing.status, 401);
    const forbidden = await fetch(`${baseUrl}/v1/dashboard/session`, { method: "POST", headers: { authorization: `Bearer ${ingestionKey}` } });
    assert.equal(forbidden.status, 401);
    const sessionResponse = await fetch(`${baseUrl}/v1/dashboard/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${readKey}`, "x-forwarded-proto": "https" }
    });
    assert.equal(sessionResponse.status, 201);
    const setCookie = sessionResponse.headers.get("set-cookie");
    assert.match(setCookie ?? "", /incidentiq_session=.*HttpOnly.*SameSite=Strict.*Secure/);
    const sessionCookie = setCookie?.split(";")[0];
    assert.ok(sessionCookie);
    const tampered = await fetch(`${baseUrl}/v1/dashboard/overview`, { headers: { cookie: `${sessionCookie}x` } });
    assert.equal(tampered.status, 401);
    const overviewResponse = await fetch(`${baseUrl}/v1/dashboard/overview`, { headers: { cookie: sessionCookie } });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json() as DashboardOverview;
    assert.deepEqual(overview.services.find((item) => item.service === service), {
      service,
      environments: [secondaryEnvironment, environment].sort(),
      event_count: 2,
      last_event_at: "2026-11-18T10:01:00.000Z",
      sources: ["github_actions"]
    });
    assert.ok(overview.environments.some((item) => item.environment === environment && item.service_count === 1 && item.event_count === 1));
    const githubActions = overview.integrations.find((item) => item.source === "github_actions");
    assert.ok(githubActions);
    assert.ok(githubActions.event_count >= 1);
    assert.ok(!Number.isNaN(Date.parse(githubActions.last_event_at)));
    const logout = await fetch(`${baseUrl}/v1/dashboard/session`, { method: "DELETE", headers: { "x-forwarded-proto": "https" } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /incidentiq_session=;.*Max-Age=0.*Secure/);
  } finally {
    await app.close();
  }
});
