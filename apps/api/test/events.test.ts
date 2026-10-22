import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApiKeysService } from "../src/api-keys.service.js";
import { createApp } from "../src/app.js";
import { DatabaseService } from "../src/database.js";

const databaseUrl = process.env.DATABASE_URL;

test("ingestion accepts, redacts, deduplicates, and rejects invalid batches", { skip: !databaseUrl }, async () => {
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  try {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const apiKey = (await app.get(ApiKeysService).create("ingest")).key;
    const event = {
      event_id: `api-test-${randomUUID()}`,
      occurred_at: "2026-10-23T12:00:00.000Z",
      tenant_id: "local",
      environment: "local",
      service: "orders",
      source: "node_sdk",
      event_type: "exception",
      severity: "error",
      attributes: { authorization: "secret", message: "database error" }
    };
    const request = (body: unknown, authorization?: string) => fetch(`${baseUrl}/v1/events/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body)
    });

    assert.equal((await request({ events: [event] })).status, 401);
    assert.equal((await request({ events: [{}] }, `Bearer ${apiKey}`)).status, 400);
    assert.deepEqual(await (await request({ events: [event] }, `Bearer ${apiKey}`)).json(), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await (await request({ events: [event] }, `Bearer ${apiKey}`)).json(), { accepted: 0, duplicates: 1 });
    const stored = await app.get(DatabaseService).db.selectFrom("source_events").select("attributes").where("event_id", "=", event.event_id).executeTakeFirstOrThrow();
    assert.deepEqual(stored.attributes, { authorization: "[REDACTED]", message: "database error" });
  } finally {
    await app.close();
  }
});
