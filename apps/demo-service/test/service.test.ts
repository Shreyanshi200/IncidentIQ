import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFailureEvent } from "../src/service.js";

test("demo failure events match the SDK event contract", () => {
  const event = createDemoFailureEvent("Demo database timeout", new Date("2026-10-23T12:00:00.000Z"));

  assert.equal(event.service, "demo-orders");
  assert.equal(event.source, "node_sdk");
  assert.equal(event.event_type, "database_timeout");
  assert.equal(event.attributes.message, "Demo database timeout");
  assert.equal(event.occurred_at, "2026-10-23T12:00:00.000Z");
});
