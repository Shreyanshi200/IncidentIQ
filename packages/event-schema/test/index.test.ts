import test from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { validateDeployment, validateEvidence, validateFixture, validateIncident, validateResource } from "@incidentiq/event-schema";

test("all canonical fixtures validate", async () => {
  for await (const file of glob("demo/fixtures/*.json", { cwd: process.cwd() })) {
    const fixture: unknown = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(validateFixture(fixture), { valid: true, errors: [] }, file);
  }
});

test("specialized contracts accept their required shapes", () => {
  const event = {
    event_id: "event-1", occurred_at: "2026-10-09T14:02:00.000Z", received_at: "2026-10-09T14:02:01.000Z",
    tenant_id: "local", environment: "local", service: "orders", source: "github_actions" as const, event_type: "deployment",
    severity: "info" as const, resource: "deployment/orders", attributes: { state: "success" }
  };
  assert.equal(validateDeployment(event).valid, true);
  assert.equal(validateResource({ ...event, source: "kubernetes", event_type: "oom_killed" }).valid, true);
  assert.equal(validateIncident({ incident_id: "incident-1", service: "orders", environment: "local", state: "open", started_at: event.occurred_at }).valid, true);
  assert.equal(validateEvidence({ evidence_id: "evidence-1", event_id: event.event_id, factor: "temporal_proximity" }).valid, true);
});

test("fixtures reject duplicate event IDs", () => {
  const event = { event_id: "duplicate", occurred_at: "2026-10-09T14:02:00.000Z", received_at: "2026-10-09T14:02:01.000Z", tenant_id: "local", environment: "local", service: "orders", source: "internal", event_type: "exception", severity: "error", attributes: {} };
  assert.equal(validateFixture({ fixture_id: "x", scenario: "x", expected_cause: "x", events: [event, event] }).valid, false);
});
