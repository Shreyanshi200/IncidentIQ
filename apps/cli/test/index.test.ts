import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("version reports the CLI and schema versions", async () => {
  const { stdout } = await run(process.execPath, [cli, "version"]);
  assert.match(stdout, /incidentiq 0\.0\.4 \(schema 0\.0\.2\)/);
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
