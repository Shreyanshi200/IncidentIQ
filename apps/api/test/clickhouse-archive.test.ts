import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { archiveRetryDelay, clickHouseConfig, ClickHouseHttpClient, pruneArchivedHotStore } from "../src/clickhouse-archive.service.js";
import { DatabaseService } from "../src/database.js";
import { clearTestTenants } from "./database-cleanup.js";

const databaseUrl = process.env.DATABASE_URL;

test("ClickHouse stays disabled until its URL is configured", () => {
  assert.equal(clickHouseConfig({}), undefined);
  assert.throws(() => clickHouseConfig({ CLICKHOUSE_URL: "postgresql://localhost" }), /http or https/);
  assert.throws(() => clickHouseConfig({ CLICKHOUSE_URL: "http://localhost:8123", CLICKHOUSE_DATABASE: "invalid-name" }), /valid unquoted identifier/);
});

test("ClickHouse configuration applies bounded archive defaults", () => {
  const config = clickHouseConfig({ CLICKHOUSE_URL: "https://clickhouse.example.com", CLICKHOUSE_PASSWORD: "secret" });
  assert.ok(config);
  assert.equal(config.database, "incidentiq");
  assert.equal(config.username, "default");
  assert.equal(config.batchSize, 500);
  assert.equal(config.flushIntervalMs, 5_000);
  assert.equal(config.hotRetentionDays, undefined);
  assert.equal(config.pruneIntervalMs, 3_600_000);
  assert.equal(archiveRetryDelay(0), 1_000);
  assert.equal(archiveRetryDelay(20), 256_000);
  assert.equal(clickHouseConfig({ CLICKHOUSE_URL: "http://localhost:8123", INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS: "7", INCIDENTIQ_POSTGRES_PRUNE_INTERVAL_MINUTES: "15" })?.hotRetentionDays, 7);
  assert.throws(() => clickHouseConfig({ CLICKHOUSE_URL: "http://localhost:8123", INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS: "0" }), /between 1 and 3650/);
});

test("ClickHouse client creates archive tables and writes newline-delimited rows", async () => {
  const requests: { url: URL; body?: string; authorization?: string }[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({
      url,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      authorization: new Headers(init?.headers).get("authorization") ?? undefined
    });
    return new Response(url.searchParams.get("query")?.startsWith("SELECT") ? '{"incident_id":"incident-1"}\n' : "", { status: 200 });
  }) as typeof fetch;
  const config = clickHouseConfig({
    CLICKHOUSE_URL: "https://clickhouse.example.com",
    CLICKHOUSE_DATABASE: "incidentiq_test",
    CLICKHOUSE_USERNAME: "archive",
    CLICKHOUSE_PASSWORD: "secret"
  });
  assert.ok(config);
  const client = new ClickHouseHttpClient(config, request);

  await client.initialize();
  await client.insert("source_events", [{ event_id: "event-1", attributes_json: "{}" }]);
  const selected = await client.query<{ incident_id: string }>("SELECT incident_id FROM incidentiq_test.incidents WHERE tenant_id = {tenant:String}", { tenant: "tenant-1" });

  assert.equal(requests.length, 4);
  assert.match(requests[0]!.url.searchParams.get("query") ?? "", /CREATE TABLE IF NOT EXISTS incidentiq_test\.source_events/);
  assert.match(requests[1]!.url.searchParams.get("query") ?? "", /CREATE TABLE IF NOT EXISTS incidentiq_test\.incidents/);
  assert.equal(requests[2]!.body, '{"event_id":"event-1","attributes_json":"{}"}');
  assert.equal(requests[2]!.authorization, `Basic ${Buffer.from("archive:secret").toString("base64")}`);
  assert.equal(requests[3]!.url.searchParams.get("param_tenant"), "tenant-1");
  assert.deepEqual(selected, [{ incident_id: "incident-1" }]);
});

test("hot retention deletes only ClickHouse-confirmed incidents and evidence", { skip: !databaseUrl }, async () => {
  const database = new DatabaseService();
  const tenantId = `archive-prune-${randomUUID()}`;
  const confirmedEventId = `${tenantId}-confirmed-event`;
  const pendingEventId = `${tenantId}-pending-event`;
  const confirmedIncidentId = `${tenantId}-confirmed-incident`;
  const pendingIncidentId = `${tenantId}-pending-incident`;
  const occurredAt = "2026-01-01T00:00:00.000Z";
  const event = {
    occurred_at: occurredAt,
    received_at: occurredAt,
    tenant_id: tenantId,
    environment: "test",
    service: "archive-test",
    source: "node_sdk" as const,
    event_type: "exception",
    severity: "error" as const,
    version: null,
    trace_id: null,
    resource: null,
    attributes: {}
  };
  const incident = {
    tenant_id: tenantId,
    service: "archive-test",
    environment: "test",
    state: "open",
    started_at: occurredAt,
    last_event_at: occurredAt,
    event_count: 1,
    leading_cause: "unknown",
    confidence: "low",
    investigation: {}
  };

  try {
    await database.db.insertInto("source_events").values([
      { ...event, event_id: confirmedEventId, clickhouse_archived_at: occurredAt },
      { ...event, event_id: pendingEventId }
    ]).execute();
    await database.db.insertInto("incidents").values([
      { ...incident, incident_id: confirmedIncidentId, clickhouse_archived_at: occurredAt },
      { ...incident, incident_id: pendingIncidentId }
    ]).execute();
    await database.db.insertInto("incident_events").values([
      { incident_id: confirmedIncidentId, event_id: confirmedEventId },
      { incident_id: pendingIncidentId, event_id: pendingEventId }
    ]).execute();

    assert.deepEqual(await pruneArchivedHotStore(database.db, "2026-02-01T00:00:00.000Z"), { incidents: 1, events: 1 });
    assert.deepEqual(await database.db.selectFrom("incidents").select("incident_id").where("tenant_id", "=", tenantId).execute(), [{ incident_id: pendingIncidentId }]);
    assert.deepEqual(await database.db.selectFrom("source_events").select("event_id").where("tenant_id", "=", tenantId).execute(), [{ event_id: pendingEventId }]);
  } finally {
    await clearTestTenants(database, tenantId);
    await database.onModuleDestroy();
  }
});
