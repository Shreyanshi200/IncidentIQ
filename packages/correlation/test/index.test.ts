import test from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import type { IncidentFixture } from "@incidentiqhq/event-schema";
import { correlate, crossServiceLinks } from "@incidentiqhq/correlation";

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

test("production-like evidence produces an explainable, contextual investigation", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/production-checkout-regression.json", "utf8")) as IncidentFixture;
  const result = correlate(fixture);
  assert.equal(result.timeline.length, 20);
  assert.equal(result.leading_cause, "bad_release");
  assert.equal(result.confidence, "high");
  assert.equal(result.scenario, fixture.scenario);
  assert.ok(result.next_checks.some((check) => check.includes("POST /checkout") && check.includes("3.4.0")));
  assert.ok(result.candidates.find((candidate) => candidate.cause === "bad_release")?.factors.some((factor) => factor.name === "version_match"));
});

test("a noisy multi-service cascade preserves the downstream cause", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/production-payment-pool-cascade.json", "utf8")) as IncidentFixture;
  const result = correlate(fixture);
  const downstream = result.candidates.find((candidate) => candidate.cause === "downstream_timeout");
  const release = result.candidates.find((candidate) => candidate.cause === "bad_release");

  assert.equal(result.timeline.length, 40);
  assert.equal(result.leading_cause, "downstream_timeout");
  assert.equal(result.confidence, "high");
  assert.ok(downstream && release && downstream.score >= release.score + 3);
  assert.equal(downstream?.score, 21);
  assert.deepEqual(downstream?.factors.map((factor) => factor.name), ["propagation_order", "trace_link"]);
  assert.deepEqual(downstream?.factors.map((factor) => factor.evidence_ids.length), [10, 10]);
  assert.ok(result.next_checks.some((check) => check.includes("postgres-primary")));
  assert.ok(result.next_checks.some((check) => check.includes("trace-cascade-a")));
});

test("cross-service links require shared traces or a declared dependency failure", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/downstream-cascade.json", "utf8")) as IncidentFixture;
  const links = crossServiceLinks(fixture.events);
  assert.ok(links.some((link) => link.reason === "shared_trace" && link.from_service === "payments-api" && link.to_service === "checkout-api"));
  assert.ok(links.some((link) => link.reason === "declared_dependency" && link.from_service === "payments-api" && link.to_service === "checkout-api"));
  assert.deepEqual(
    links.find((link) => link.reason === "declared_dependency" && link.trace_id === "trace-pay-702")?.evidence_ids.sort(),
    ["checkout-trace-702-failed", "payments-trace-702-timeout"]
  );
  assert.deepEqual(crossServiceLinks(fixture.events.map((event) => ({ ...event, trace_id: undefined, attributes: {} }))), []);
});

test("cross-service links stay inside one tenant, environment, and evidence window", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/downstream-cascade.json", "utf8")) as IncidentFixture;
  const source = fixture.events.find((event) => event.event_id === "payments-trace-702-timeout")!;
  const target = fixture.events.find((event) => event.event_id === "checkout-trace-702-failed")!;
  const unrelated = [
    { ...target, event_id: "other-tenant", tenant_id: "other" },
    { ...target, event_id: "other-environment", environment: "staging" },
    { ...target, event_id: "outside-window", occurred_at: new Date(Date.parse(source.occurred_at) + 11 * 60_000).toISOString() }
  ];

  assert.deepEqual(crossServiceLinks([source, ...unrelated]), []);
});

test("multi-hop traces preserve adjacent topology without inventing fan-out links", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/production-commerce-platform-cascade.json", "utf8")) as IncidentFixture;
  const links = crossServiceLinks(fixture.events);
  const shared = links.filter((link) => link.reason === "shared_trace" && link.trace_id === "trace-mega-a");

  assert.deepEqual(
    shared.map((link) => `${link.from_service}->${link.to_service}`),
    ["checkout-api->edge-api", "orders-api->payments-api", "payments-api->checkout-api", "postgres-primary->orders-api"]
  );
  assert.ok(!links.some((link) => link.from_service === "postgres-primary" && link.to_service === "edge-api"));
  assert.ok(!links.some((link) => link.from_service === "fraud-api" || link.to_service === "fraud-api"));
});

test("all Node SDK error types participate in correlation", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const events = fixture.events.map((event) => event.source === "node_sdk" ? { ...event, event_type: "database_timeout", severity: "critical" as const } : event);
  const result = correlate({ ...fixture, events });
  assert.equal(result.leading_cause, "deployment_regression");
  assert.equal(result.confidence, "high");
});

test("correlation accepts a configured evidence window", async () => {
  const fixture = JSON.parse(await readFile("demo/fixtures/deployment-regression.json", "utf8")) as IncidentFixture;
  const events = fixture.events.map((event) => event.source === "node_sdk" ? { ...event, occurred_at: "2026-10-09T14:17:00.000Z", received_at: "2026-10-09T14:17:01.000Z" } : event);
  assert.equal(correlate({ ...fixture, events }).leading_cause, "ambiguous");
  const configured = correlate({ ...fixture, events }, { eventWindowMs: 20 * 60 * 1000 });
  assert.equal(configured.leading_cause, "deployment_regression");
  assert.equal(configured.correlation_window_ms, 20 * 60 * 1000);
  assert.throws(() => correlate(fixture, { eventWindowMs: 0 }), /eventWindowMs must be a positive number/);
});
