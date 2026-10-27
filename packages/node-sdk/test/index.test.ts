import test from "node:test";
import assert from "node:assert/strict";
import { createIncidentIQ } from "../src/index.js";

const event = (eventId: string) => ({
  event_id: eventId,
  occurred_at: "2026-10-23T12:00:00.000Z",
  received_at: "2026-10-23T12:00:00.000Z",
  tenant_id: "local",
  environment: "local",
  service: "orders",
  source: "node_sdk" as const,
  event_type: "exception",
  severity: "error" as const,
  attributes: { message: "database error" }
});

test("batches events with the ingestion API authorization", async () => {
  const requests: Array<{ url: string; authorization: string | null; events: string[] }> = [];
  const client = createIncidentIQ({
    apiKey: "iiq_test",
    apiUrl: "http://incidentiq.test/",
    batchSize: 2,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { events: Array<{ event_id: string }> };
      requests.push({ url: String(input), authorization: headers.get("authorization"), events: body.events.map((item) => item.event_id) });
      return new Response(null, { status: 202 });
    }
  });

  client.track(event("one"));
  client.track(event("two"));
  assert.equal(await client.flush(), true);
  assert.equal(await client.shutdown(), true);

  assert.deepEqual(requests, [{ url: "http://incidentiq.test/v1/events/batch", authorization: "Bearer iiq_test", events: ["one", "two"] }]);
});

test("flushes a partial batch after the configured interval", async () => {
  let sent = 0;
  const client = createIncidentIQ({
    apiKey: "iiq_test",
    flushIntervalMs: 1,
    fetch: async () => {
      sent += 1;
      return new Response(null, { status: 202 });
    }
  });

  client.track(event("delayed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await client.shutdown(), true);

  assert.equal(sent, 1);
});

test("fails open and retries queued events on the next flush", async () => {
  let attempts = 0;
  const client = createIncidentIQ({
    apiKey: "iiq_test",
    flushIntervalMs: 60_000,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return new Response(null, { status: 202 });
    }
  });

  client.track(event("retry"));
  assert.equal(await client.flush(), false);
  assert.equal(await client.flush(), true);
  assert.equal(await client.shutdown(), true);

  assert.equal(attempts, 2);
});

test("bounds the in-memory queue while the API is unavailable", async () => {
  const sent: string[][] = [];
  const client = createIncidentIQ({
    apiKey: "iiq_test",
    batchSize: 10,
    maxQueueSize: 2,
    flushIntervalMs: 60_000,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ event_id: string }> };
      sent.push(body.events.map((item) => item.event_id));
      return new Response(null, { status: 202 });
    }
  });

  client.track(event("one"));
  client.track(event("two"));
  client.track(event("three"));
  assert.equal(await client.flush(), true);
  assert.equal(await client.shutdown(), true);

  assert.deepEqual(sent, [["two", "three"]]);
});
