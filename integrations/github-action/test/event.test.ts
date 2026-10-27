import test from "node:test";
import assert from "node:assert/strict";
import { createDeploymentEvent } from "../src/event.js";
import { run } from "../src/run.js";

test("creates deployment context from GitHub Actions metadata", () => {
  const event = createDeploymentEvent({
    tenantId: "acme",
    service: "orders",
    environment: "production",
    status: "success",
    repository: "acme/orders",
    sha: "abc123",
    ref: "main",
    workflow: "Deploy",
    runId: "42",
    runAttempt: "1",
    serverUrl: "https://github.example",
    actor: "octocat"
  }, new Date("2026-10-23T12:00:00.000Z"));

  assert.equal(event.source, "github_actions");
  assert.equal(event.event_type, "deployment");
  assert.equal(event.severity, "info");
  assert.equal(event.version, "abc123");
  assert.deepEqual(event.attributes, {
    deployment_status: "success",
    repository: "acme/orders",
    commit_sha: "abc123",
    ref: "main",
    workflow: "Deploy",
    run_id: "42",
    run_attempt: "1",
    run_url: "https://github.example/acme/orders/actions/runs/42",
    actor: "octocat"
  });
});

test("marks a failed deployment as an error", () => {
  const event = createDeploymentEvent({ tenantId: "acme", service: "orders", environment: "production", status: "failure" });

  assert.equal(event.severity, "error");
});

test("reports an accepted deployment context", async () => {
  const originalFetch = globalThis.fetch;
  const values = {
    "INPUT_API-KEY": "iiq_test",
    "INPUT_API-URL": "http://incidentiq.test",
    "INPUT_TENANT-ID": "local",
    "INPUT_SERVICE": "orders",
    "INPUT_ENVIRONMENT": "production"
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const logs: string[] = [];
  const warnings: string[] = [];

  try {
    await run((message) => logs.push(message), (message) => warnings.push(message));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.deepEqual(logs, ["IncidentIQ recorded deployment context for orders"]);
  assert.deepEqual(warnings, []);
});

test("warns when the API rejects a deployment context", async () => {
  const originalFetch = globalThis.fetch;
  const values = {
    "INPUT_API-KEY": "iiq_test",
    "INPUT_API-URL": "http://incidentiq.test",
    "INPUT_TENANT-ID": "local",
    "INPUT_SERVICE": "orders",
    "INPUT_ENVIRONMENT": "production"
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  globalThis.fetch = async () => new Response(null, { status: 401 });
  const logs: string[] = [];
  const warnings: string[] = [];

  try {
    await run((message) => logs.push(message), (message) => warnings.push(message));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.deepEqual(logs, []);
  assert.deepEqual(warnings, ["IncidentIQ deployment context was not exported: the API did not accept the event"]);
});
