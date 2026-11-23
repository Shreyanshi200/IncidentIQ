import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabase } from "../src/database.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

test("version reports the CLI and schema versions", async () => {
  const { stdout } = await run(process.execPath, [cli, "version"]);
  assert.match(stdout, /incidentiq 0\.9\.0 \(schema 0\.0\.6\)/);
});

test("correlate ranks the seeded cause", async () => {
  const { stdout } = await run(process.execPath, [cli, "correlate", "demo/fixtures/downstream-cascade.json"]);
  assert.match(stdout, /Likely cause: downstream timeout \(high confidence\)/);
  assert.match(stdout, /Next checks:/);
});

test("fixture validate accepts a canonical fixture", async () => {
  const { stdout } = await run(process.execPath, [cli, "fixture", "validate", "demo/fixtures/deployment-regression.json"]);
  assert.match(stdout, /Valid fixture: deployment-regression/);
});

test("fixture ingest sends the prepared scenario through the authenticated API", async () => {
  const server = createServer();
  const received = new Promise<{ authorization: string | undefined; body: { events: unknown[] } }>((resolveRequest) => {
    server.once("request", (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { events: unknown[] };
        resolveRequest({ authorization: request.headers.authorization, body: parsed });
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: parsed.events.length, duplicates: 0 }));
      });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const port = (server.address() as AddressInfo).port;
    const { stdout } = await run(process.execPath, [cli, "fixture", "ingest", "demo/fixtures/production-payment-pool-cascade.json", "--tenant", "fixture-test"], {
      env: { ...process.env, INCIDENTIQ_API_URL: `http://127.0.0.1:${port}`, INCIDENTIQ_API_KEY: "iiq_fixture_test" }
    });
    const request = await received;
    assert.equal(request.authorization, "Bearer iiq_fixture_test");
    assert.equal(request.body.events.length, 40);
    assert.ok(request.body.events.every((event) => (event as { tenant_id?: string }).tenant_id === "fixture-test"));
    assert.ok(request.body.events.every((event) => (event as { event_id?: string }).event_id?.startsWith("fixture-test:")));
    assert.match(stdout, /40 accepted, 0 duplicate/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("fixture ingest rejects a missing API key before sending evidence", async () => {
  const env = { ...process.env };
  delete env.INCIDENTIQ_API_KEY;
  await assert.rejects(
    () => run(process.execPath, [cli, "fixture", "ingest", "demo/fixtures/downstream-cascade.json"], { env }),
    /INCIDENTIQ_API_KEY is required/
  );
});

test("keys create can create a read key", { skip: !databaseUrl }, async () => {
  const tenant = `cli-${Date.now()}`;
  const { stdout } = await run(process.execPath, [cli, "keys", "create", "--scope", "read", "--tenant", tenant, "--label", "operator"], { env: process.env });
  assert.match(stdout, /Created read key .* for tenant cli-/);
  assert.match(stdout, /API key \(shown once\): iiq_/);
  const key = stdout.match(/API key \(shown once\): (iiq_[A-Za-z0-9_-]+)/)?.[1];
  const keyId = stdout.match(/Created read key ([0-9a-f-]+)/)?.[1];
  assert.ok(key);
  assert.ok(keyId);
  const database = createDatabase(databaseUrl);
  try {
    const { stdout: listed } = await run(process.execPath, [cli, "keys", "list", "--tenant", tenant], { env: process.env });
    assert.match(listed, /"label": "operator"/);
    assert.doesNotMatch(listed, new RegExp(key));
    const { stdout: revoked } = await run(process.execPath, [cli, "keys", "revoke", keyId, "--tenant", tenant, "--confirm"], { env: process.env });
    assert.match(revoked, /Revoked read key/);
    await database.deleteFrom("api_keys").where("key_hash", "=", createHash("sha256").update(key).digest("hex")).execute();
  } finally {
    await database.destroy();
  }
});
