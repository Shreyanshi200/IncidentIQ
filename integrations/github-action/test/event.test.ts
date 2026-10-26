import test from "node:test";
import assert from "node:assert/strict";
import { createDeploymentEvent } from "../src/event.js";

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
