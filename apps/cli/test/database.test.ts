import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncidentFixture } from "@incidentiqhq/event-schema";
import { applyMigrations, archiveStatus, clearTenantData, createApiKey, createDatabase, discardArchiveQueue, getIncident, listApiKeys, listEvents, listIncidents, loadFixture, pruneTenantData, queueArchiveBackfill, revokeApiKey, saveInvestigation } from "../src/database.js";
import { correlate } from "@incidentiqhq/correlation";

const databaseUrl = process.env.DATABASE_URL;

test("migrations and fixture loads are idempotent", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const suffix = randomUUID();
  const tenantId = `test-${suffix}`;
  const uniqueFixture = { ...fixture, events: fixture.events.map((event) => ({ ...event, event_id: `${event.event_id}-${suffix}`, tenant_id: tenantId })) };
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    assert.deepEqual(await loadFixture(database, uniqueFixture), { inserted: uniqueFixture.events.length, duplicates: 0 });
    assert.deepEqual(await loadFixture(database, uniqueFixture), { inserted: 0, duplicates: uniqueFixture.events.length });
    const loadedEvents = (await listEvents(database)).filter((event) => event.event_id.endsWith(suffix));
    assert.equal(loadedEvents.length, uniqueFixture.events.length);
    assert.deepEqual(loadedEvents.map((event) => event.event_id), [
      `orders-restart-1-${suffix}`,
      `orders-db-error-1-${suffix}`,
      `deploy-orders-1-${suffix}`
    ]);
    await saveInvestigation(database, correlate({ ...uniqueFixture, fixture_id: `incident-${suffix}` }));
    assert.equal((await listIncidents(database)).some((incident) => incident.incident_id === `incident-${suffix}`), true);
    assert.equal((await getIncident(database, `incident-${suffix}`))?.investigation.leading_cause, "deployment_regression");
    const linkedEvidence = await database.selectFrom("incident_events").select("event_id").where("incident_id", "=", `incident-${suffix}`).execute();
    assert.equal(linkedEvidence.length, uniqueFixture.events.length);
  } finally {
    await clearTenantData(database, tenantId);
    await database.destroy();
  }
});

test("tenant cleanup removes evidence and incidents only from the selected tenant", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const tenantId = `cleanup-${randomUUID()}`;
  const scopedFixture = {
    ...fixture,
    fixture_id: `incident-${tenantId}`,
    events: fixture.events.map((event) => ({ ...event, event_id: `${event.event_id}-${tenantId}`, tenant_id: tenantId }))
  };
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    await loadFixture(database, scopedFixture);
    await saveInvestigation(database, correlate(scopedFixture));
    assert.deepEqual((await listIncidents(database, tenantId)).map((incident) => incident.incident_id), [scopedFixture.fixture_id]);
    assert.deepEqual(await clearTenantData(database, tenantId), { incidents: 1, events: scopedFixture.events.length });
    assert.equal((await listEvents(database)).some((event) => event.tenant_id === tenantId), false);
    assert.equal((await listIncidents(database)).some((incident) => incident.tenant_id === tenantId), false);
  } finally {
    await database.destroy();
  }
});

test("archive backfill queues existing evidence once and tenant cleanup removes its queue", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const tenantId = `archive-${randomUUID()}`;
  const scopedFixture = {
    ...fixture,
    fixture_id: `incident-${tenantId}`,
    events: fixture.events.map((event) => ({ ...event, event_id: `${event.event_id}-${tenantId}`, tenant_id: tenantId }))
  };
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    await loadFixture(database, scopedFixture);
    await saveInvestigation(database, correlate(scopedFixture));
    assert.deepEqual(await queueArchiveBackfill(database, tenantId), { events: scopedFixture.events.length, incidents: 1 });
    const status = await archiveStatus(database, tenantId);
    assert.equal(status.queued, scopedFixture.events.length + 1);
    assert.equal(status.retrying, 0);
    assert.ok(status.oldest_queued_at);
    assert.deepEqual(await queueArchiveBackfill(database, tenantId), { events: 0, incidents: 1 });
    assert.equal(await discardArchiveQueue(database, tenantId), scopedFixture.events.length + 1);
    assert.equal((await archiveStatus(database, tenantId)).queued, 0);
  } finally {
    await clearTenantData(database, tenantId);
    await database.destroy();
  }
});

test("API keys can be identified and revoked without exposing their secret", { skip: !databaseUrl }, async () => {
  const tenantId = `keys-${randomUUID()}`;
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    const created = await createApiKey(database, "read", { tenantId, label: "dashboard", expiresAt: "2030-01-01T00:00:00.000Z" });
    const listed = await listApiKeys(database, tenantId);
    assert.deepEqual(listed.map(({ key_id, visible_prefix, scope, tenant_id, label, expires_at, revoked_at }) => ({ key_id, visible_prefix, scope, tenant_id, label, expires_at, revoked_at })), [{
      key_id: created.keyId,
      visible_prefix: created.visiblePrefix,
      scope: "read",
      tenant_id: tenantId,
      label: "dashboard",
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked_at: null
    }]);
    assert.equal(JSON.stringify(listed).includes(created.key), false);
    assert.equal((await revokeApiKey(database, created.keyId, tenantId))?.key_id, created.keyId);
    assert.ok((await listApiKeys(database, tenantId))[0]?.revoked_at);
    assert.equal(await revokeApiKey(database, created.keyId, tenantId), undefined);
  } finally {
    await database.deleteFrom("api_keys").where("tenant_id", "=", tenantId).execute();
    await database.destroy();
  }
});

test("retention dry-runs before deleting expired incidents and unretained events", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const tenantId = `retention-${randomUUID()}`;
  const expired = {
    ...fixture,
    fixture_id: `expired-${tenantId}`,
    events: fixture.events.map((event) => ({ ...event, event_id: `expired-${event.event_id}-${tenantId}`, tenant_id: tenantId }))
  };
  const retained = {
    ...fixture,
    fixture_id: `retained-${tenantId}`,
    events: fixture.events.map((event, index) => ({
      ...event,
      event_id: `retained-${event.event_id}-${tenantId}`,
      tenant_id: tenantId,
      occurred_at: index === 0 ? "2026-10-01T00:00:00.000Z" : `2026-11-02T00:0${index}:00.000Z`,
      received_at: index === 0 ? "2026-10-01T00:00:01.000Z" : `2026-11-02T00:0${index}:01.000Z`
    }))
  };
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    await loadFixture(database, expired);
    await saveInvestigation(database, correlate(expired));
    await loadFixture(database, retained);
    await saveInvestigation(database, correlate(retained));

    const cutoff = "2026-11-01T00:00:00.000Z";
    assert.deepEqual(await pruneTenantData(database, tenantId, cutoff, false, false), {
      tenant_id: tenantId,
      cutoff,
      incidents: 1,
      events: expired.events.length,
      deleted: false
    });
    assert.equal((await listIncidents(database, tenantId)).length, 2);
    assert.equal((await listEvents(database)).filter((event) => event.tenant_id === tenantId).length, expired.events.length + retained.events.length);

    assert.deepEqual(await pruneTenantData(database, tenantId, cutoff, true, false), {
      tenant_id: tenantId,
      cutoff,
      incidents: 1,
      events: expired.events.length,
      deleted: true
    });
    assert.deepEqual((await listIncidents(database, tenantId)).map((incident) => incident.incident_id), [retained.fixture_id]);
    assert.deepEqual((await listEvents(database)).filter((event) => event.tenant_id === tenantId).map((event) => event.event_id).sort(), retained.events.map((event) => event.event_id).sort());
  } finally {
    await clearTenantData(database, tenantId);
    await database.destroy();
  }
});

test("tiered retention deletes only records with confirmed ClickHouse delivery", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const tenantId = `tiering-${randomUUID()}`;
  const archived = {
    ...fixture,
    fixture_id: `archived-${tenantId}`,
    events: fixture.events.map((event) => ({ ...event, event_id: `${event.event_id}-${tenantId}`, tenant_id: tenantId }))
  };
  const database = createDatabase(databaseUrl);
  const cutoff = "2026-11-01T00:00:00.000Z";
  try {
    await applyMigrations(database);
    await loadFixture(database, archived);
    await saveInvestigation(database, correlate(archived));
    assert.deepEqual(await pruneTenantData(database, tenantId, cutoff, false, true), { tenant_id: tenantId, cutoff, incidents: 0, events: 0, deleted: false });

    const confirmedAt = "2026-10-24T00:00:00.000Z";
    await database.updateTable("source_events").set({ clickhouse_archived_at: confirmedAt }).where("tenant_id", "=", tenantId).execute();
    await database.updateTable("incidents").set({ clickhouse_archived_at: confirmedAt }).where("tenant_id", "=", tenantId).execute();
    assert.deepEqual(await pruneTenantData(database, tenantId, cutoff, true, true), { tenant_id: tenantId, cutoff, incidents: 1, events: archived.events.length, deleted: true });
  } finally {
    await clearTenantData(database, tenantId);
    await database.destroy();
  }
});
