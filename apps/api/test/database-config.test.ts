import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { databaseEnvPaths, loadEnvironment } from "../src/database.js";

test("looks for the repository environment file when started from the API package", () => {
  assert.deepEqual(databaseEnvPaths(resolve("apps/api")), [
    resolve("apps/api/.env"),
    resolve(".env")
  ]);
});

test("loads missing settings even when DATABASE_URL is already exported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incidentiq-env-"));
  const previousDatabase = process.env.DATABASE_URL;
  const previousModel = process.env.INCIDENTIQ_AI_MODEL;
  process.env.DATABASE_URL = "postgresql://exported-value";
  delete process.env.INCIDENTIQ_AI_MODEL;
  try {
    await writeFile(join(directory, ".env"), "DATABASE_URL=postgresql://file-value\nINCIDENTIQ_AI_MODEL=file-model\n");
    loadEnvironment(directory);
    assert.equal(process.env.DATABASE_URL, "postgresql://exported-value");
    assert.equal(process.env.INCIDENTIQ_AI_MODEL, "file-model");
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousModel === undefined) delete process.env.INCIDENTIQ_AI_MODEL; else process.env.INCIDENTIQ_AI_MODEL = previousModel;
    await rm(directory, { recursive: true, force: true });
  }
});
