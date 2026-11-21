import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabase } from "../src/database.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

test("version reports the CLI and schema versions", async () => {
  const { stdout } = await run(process.execPath, [cli, "version"]);
  assert.match(stdout, /incidentiq 0\.8\.1 \(schema 0\.0\.6\)/);
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
