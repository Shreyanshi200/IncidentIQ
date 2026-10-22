import test from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import type { IncidentFixture } from "@incidentiq/event-schema";
import { correlate } from "@incidentiq/correlation";

test("canonical fixtures rank their expected cause", async () => {
  for await (const file of glob("demo/fixtures/*.json", { cwd: process.cwd() })) {
    const fixture = JSON.parse(await readFile(file, "utf8")) as IncidentFixture;
    assert.equal(correlate(fixture).leading_cause, fixture.expected_cause, file);
  }
});

test("ambiguous evidence has low confidence", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/ambiguous-failure.json", "utf8")) as IncidentFixture;
  const result = correlate(fixture);
  assert.equal(result.confidence, "low");
  assert.ok(result.candidates.some((candidate) => candidate.cause === "deployment_regression"));
  assert.ok(result.candidates.some((candidate) => candidate.cause === "resource_exhaustion"));
});

test("an error before a deployment is counterevidence", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const firstError = fixture.events[1];
  const result = correlate({
    ...fixture,
    events: [...fixture.events, { ...firstError, event_id: "orders-pre-deploy", occurred_at: "2026-10-09T14:01:00.000Z", received_at: "2026-10-09T14:01:01.000Z" }]
  });
  const deployment = result.candidates.find((candidate) => candidate.cause === "deployment_regression");
  assert.ok(deployment?.factors.some((factor) => factor.name === "counterevidence"));
  assert.equal(result.leading_cause, "ambiguous");
});
