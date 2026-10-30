import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { databaseEnvPaths } from "../src/database.js";

test("looks for the repository environment file when started from the API package", () => {
  assert.deepEqual(databaseEnvPaths(resolve("apps/api")), [
    resolve("apps/api/.env"),
    resolve(".env")
  ]);
});
