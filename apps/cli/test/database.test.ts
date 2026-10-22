import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncidentFixture } from "@incidentiq/event-schema";
import { applyMigrations, createDatabase, getIncident, listEvents, listIncidents, loadFixture, saveInvestigation } from "../src/database.js";
import { correlate } from "@incidentiq/correlation";

const databaseUrl = process.env.DATABASE_URL;

test("migrations and fixture loads are idempotent", { skip: !databaseUrl }, async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const suffix = randomUUID();
  const uniqueFixture = { ...fixture, events: fixture.events.map((event) => ({ ...event, event_id: `${event.event_id}-${suffix}` })) };
  const database = createDatabase(databaseUrl);
  try {
    await applyMigrations(database);
    assert.deepEqual(await loadFixture(database, uniqueFixture), { inserted: uniqueFixture.events.length, duplicates: 0 });
    assert.deepEqual(await loadFixture(database, uniqueFixture), { inserted: 0, duplicates: uniqueFixture.events.length });
    assert.equal((await listEvents(database)).filter((event) => event.event_id.endsWith(suffix)).length, uniqueFixture.events.length);
    await saveInvestigation(database, correlate({ ...uniqueFixture, fixture_id: `incident-${suffix}` }));
    assert.equal((await listIncidents(database)).some((incident) => incident.incident_id === `incident-${suffix}`), true);
    assert.equal((await getIncident(database, `incident-${suffix}`))?.investigation.leading_cause, "deployment_regression");
  } finally {
    await database.destroy();
  }
});
