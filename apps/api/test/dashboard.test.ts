import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApiKeysService } from "../src/api-keys.service.js";
import { createApp } from "../src/app.js";
import { DatabaseService } from "../src/database.js";
import type { DashboardIncidentPage, DashboardOverview, DashboardTimelineEvent } from "../src/dashboard.service.js";
import { describeReportEvent } from "../src/incident-report.js";

const databaseUrl = process.env.DATABASE_URL;

test("incident reports explain recovery evidence instead of exposing only attributes", () => {
  const base: Omit<DashboardTimelineEvent, "source" | "event_type" | "attributes"> = {
    event_id: "recovery",
    occurred_at: "2026-11-19T10:08:00.000Z",
    service: "checkout-api",
    environment: "production",
    severity: "info",
    version: "3.3.7",
    resource: "deployment/checkout-api"
  };
  assert.equal(describeReportEvent({ ...base, source: "kubernetes", event_type: "deployment_recovered", attributes: { status: "healthy", ready_replicas: 6, desired_replicas: 6 } }), "deployment/checkout-api recovered on version 3.3.7 with 6 of 6 replicas ready.");
  assert.equal(describeReportEvent({ ...base, source: "alertmanager", event_type: "alert_resolved", attributes: { status: "resolved", alertname: "CheckoutHighErrorRate", current_value: "0.8%", threshold: "5%" } }), "CheckoutHighErrorRate resolved at 0.8%; configured threshold is 5%.");
});

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
    assert.ok(githubActions.recent_event_count >= 1);
    assert.ok(!Number.isNaN(Date.parse(githubActions.last_event_at)));
    const logout = await fetch(`${baseUrl}/v1/dashboard/session`, { method: "DELETE", headers: { "x-forwarded-proto": "https" } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /incidentiq_session=;.*Max-Age=0.*Secure/);
  } finally {
    await app.close();
  }
});

test("dashboard lists tenant-scoped incidents, filters them, and returns their evidence timeline", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const apiKeys = app.get(ApiKeysService);
    const tenant = `test-${randomUUID()}`;
    const otherTenant = `test-${randomUUID()}`;
    const ingestionKey = (await apiKeys.create("ingest", tenant)).key;
    const readKey = (await apiKeys.create("read", tenant)).key;
    const otherKey = (await apiKeys.create("ingest", otherTenant)).key;
    const service = `payments-${randomUUID()}`;
    const environment = "production";
    const otherService = `catalog-${randomUUID()}`;
    const events = [
      {
        event_id: `deploy-${randomUUID()}`,
        occurred_at: "2026-11-19T10:00:00.000Z",
        tenant_id: tenant,
        environment,
        service,
        source: "github_actions",
        event_type: "deployment",
        severity: "info",
        version: "1.2.3",
        attributes: { state: "success" }
      },
      {
        event_id: `error-${randomUUID()}`,
        occurred_at: "2026-11-19T10:01:00.000Z",
        tenant_id: tenant,
        environment,
        service,
        source: "node_sdk",
        event_type: "checkout_failed",
        severity: "critical",
        version: "1.2.3",
        attributes: { route: "/checkout" }
      },
      {
        event_id: `restart-${randomUUID()}`,
        occurred_at: "2026-11-19T10:02:00.000Z",
        tenant_id: tenant,
        environment,
        service,
        source: "kubernetes",
        event_type: "pod_restart",
        severity: "warning",
        resource: `pod/payments/${service}`,
        attributes: { restarts: 1 }
      },
      {
        event_id: `other-${randomUUID()}`,
        occurred_at: "2026-11-19T10:03:00.000Z",
        tenant_id: tenant,
        environment: "staging",
        service: otherService,
        source: "node_sdk",
        event_type: "exception",
        severity: "error",
        attributes: { message: "timeout" }
      }
    ];
    const accepted = await fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ingestionKey}` },
      body: JSON.stringify({ events })
    });
    assert.deepEqual(await accepted.json(), { accepted: events.length, duplicates: 0 });
    const otherTenantEvent = await fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${otherKey}` },
      body: JSON.stringify({ events: [{ ...events[1], event_id: `other-tenant-${randomUUID()}`, tenant_id: otherTenant }] })
    });
    assert.deepEqual(await otherTenantEvent.json(), { accepted: 1, duplicates: 0 });
    const otherIncident = await app.get(DatabaseService).db.selectFrom("incidents").select("incident_id").where("tenant_id", "=", otherTenant).executeTakeFirstOrThrow();

    const session = await fetch(`${baseUrl}/v1/dashboard/session`, { method: "POST", headers: { authorization: `Bearer ${readKey}` } });
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const incidents = await fetch(`${baseUrl}/v1/dashboard/incidents?service=${encodeURIComponent(service)}&environment=${environment}`, { headers: { cookie } });
    assert.equal(incidents.status, 200);
    const listed = await incidents.json() as DashboardIncidentPage;
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.service, service);
    assert.equal(listed.items[0]?.event_count, 3);
    assert.equal(listed.items[0]?.leading_cause, "bad_release");

    const sourceFiltered = await fetch(`${baseUrl}/v1/dashboard/incidents?source=github_actions`, { headers: { cookie } });
    const bySource = await sourceFiltered.json() as DashboardIncidentPage;
    assert.deepEqual(bySource.items.map((item) => item.incident_id), [listed.items[0]?.incident_id]);
    const detail = await fetch(`${baseUrl}/v1/dashboard/incidents/${listed.items[0]?.incident_id}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const incident = await detail.json() as {
      brief: { headline: string; summary: string; supporting_evidence: Array<{ name: string; description: string; evidence_ids: string[] }>; candidates: Array<{ cause: string; score: number }> };
      timeline: Array<{ event_id: string; source: string; event_type: string }>;
      next_checks: string[];
    };
    assert.deepEqual(incident.timeline.map((event) => event.event_id), events.slice(0, 3).map((event) => event.event_id));
    assert.deepEqual(incident.timeline.map((event) => `${event.source}:${event.event_type}`), ["github_actions:deployment", "node_sdk:checkout_failed", "kubernetes:pod_restart"]);
    assert.match(incident.brief.headline, /release/i);
    assert.match(incident.brief.summary, /1\.2\.3.*\/checkout/);
    assert.ok(incident.brief.supporting_evidence.some((factor) => factor.name === "version_match" && factor.evidence_ids.length === 2));
    assert.match(incident.brief.supporting_evidence.find((factor) => factor.name === "temporal_proximity")?.description ?? "", /deployment of version 1\.2\.3.*1 minute later.*checkout failed on \/checkout/i);
    assert.equal(incident.brief.candidates[0]?.cause, "bad_release");
    assert.ok(incident.next_checks.some((check) => check.includes("/checkout") && check.includes("1.2.3")));
    const reportResponse = await fetch(`${baseUrl}/v1/dashboard/incidents/${listed.items[0]?.incident_id}/report`, { headers: { cookie } });
    assert.equal(reportResponse.status, 200);
    assert.match(reportResponse.headers.get("content-type") ?? "", /application\/pdf/);
    assert.match(reportResponse.headers.get("content-disposition") ?? "", /attachment; filename="incidentiq-.*\.pdf"/);
    const report = Buffer.from(await reportResponse.arrayBuffer());
    assert.equal(report.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(report.length > 3_000);
    const crossTenant = await fetch(`${baseUrl}/v1/dashboard/incidents/${otherIncident.incident_id}`, { headers: { cookie } });
    assert.equal(crossTenant.status, 404);
    const crossTenantReport = await fetch(`${baseUrl}/v1/dashboard/incidents/${otherIncident.incident_id}/report`, { headers: { cookie } });
    assert.equal(crossTenantReport.status, 404);
  } finally {
    await app.close();
  }
});

test("dashboard pages tenant-scoped incident lists with an opaque stable cursor", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const apiKeys = app.get(ApiKeysService);
    const tenant = `test-${randomUUID()}`;
    const readKey = (await apiKeys.create("read", tenant)).key;
    const database = app.get(DatabaseService).db;
    const identifiers = Array.from({ length: 26 }, (_, index) => `page-${randomUUID()}-${index}`);

    await database
      .insertInto("incidents")
      .values(identifiers.map((incident_id, index) => ({
        incident_id,
        tenant_id: tenant,
        service: `service-${index}`,
        environment: "test",
        state: "open",
        started_at: new Date(Date.UTC(2026, 10, 19, 10, 0, index)).toISOString(),
        last_event_at: new Date(Date.UTC(2026, 10, 19, 10, 0, index)).toISOString(),
        event_count: 1,
        leading_cause: "ambiguous",
        confidence: "low",
        investigation: { next_checks: [] }
      })))
      .execute();

    const session = await fetch(`${baseUrl}/v1/dashboard/session`, { method: "POST", headers: { authorization: `Bearer ${readKey}` } });
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const firstResponse = await fetch(`${baseUrl}/v1/dashboard/incidents`, { headers: { cookie } });
    assert.equal(firstResponse.status, 200);
    const firstPage = await firstResponse.json() as DashboardIncidentPage;
    assert.equal(firstPage.items.length, 25);
    assert.ok(firstPage.next_cursor);

    const secondResponse = await fetch(`${baseUrl}/v1/dashboard/incidents?cursor=${encodeURIComponent(firstPage.next_cursor ?? "")}`, { headers: { cookie } });
    assert.equal(secondResponse.status, 200);
    const secondPage = await secondResponse.json() as DashboardIncidentPage;
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.next_cursor, undefined);
    assert.deepEqual(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.incident_id)),
      new Set(identifiers)
    );

    const malformed = await fetch(`${baseUrl}/v1/dashboard/incidents?cursor=not-a-cursor`, { headers: { cookie } });
    assert.equal(malformed.status, 400);
  } finally {
    await app.close();
  }
});
