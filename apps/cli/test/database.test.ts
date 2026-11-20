import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncidentFixture } from "@incidentiqhq/event-schema";
import { applyMigrations, clearTenantData, createDatabase, getIncident, listEvents, listIncidents, loadFixture, saveInvestigation } from "../src/database.js";
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
