import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "incidentiq-npm-package-"));
const packageDirectory = join(temporaryDirectory, "packages");
const consumerDirectory = join(temporaryDirectory, "consumer");

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, { cwd, env: { ...process.env, CI: "true", npm_config_cache: join(temporaryDirectory, "npm-cache") }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} failed with exit status ${result.status}`);
}

function tarball(packages, prefix) {
  const match = packages.find((file) => file.startsWith(prefix) && file.endsWith(".tgz"));
  if (!match) throw new Error(`Could not find ${prefix} package tarball`);
  return join(packageDirectory, match);
}

try {
  run("pnpm", ["--dir", "packages/event-schema", "pack", "--pack-destination", packageDirectory]);
  run("pnpm", ["--dir", "packages/node-sdk", "pack", "--pack-destination", packageDirectory]);

  const packages = await readdir(packageDirectory);
  const schema = tarball(packages, "incidentiqhq-event-schema-");
  const sdk = tarball(packages, "incidentiqhq-node-sdk-");

  await mkdir(consumerDirectory);
  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ name: "incidentiq-sdk-consumer-check", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false", schema], consumerDirectory);
  run("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false", sdk], consumerDirectory);
  await writeFile(join(consumerDirectory, "consumer.ts"), `import { createIncidentIQ } from "@incidentiqhq/node-sdk";

const client = createIncidentIQ({ apiKey: "iiq_test" });
client.track({
  event_id: "external-consumer-check",
  occurred_at: new Date().toISOString(),
  received_at: new Date().toISOString(),
  tenant_id: "local",
  environment: "test",
  service: "orders",
  source: "node_sdk",
  event_type: "exception",
  severity: "error",
  attributes: { message: "package type check" }
});
void client.shutdown();
`);
  await writeFile(join(consumerDirectory, "consumer.mjs"), `import { createIncidentIQ } from "@incidentiqhq/node-sdk";

const client = createIncidentIQ({ apiKey: "iiq_test" });
if (typeof client.track !== "function") throw new Error("SDK export is unavailable");
await client.shutdown();
`);
  run(join(root, "node_modules/.bin/tsc"), ["--noEmit", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2024", "consumer.ts"], consumerDirectory);
  run(process.execPath, ["consumer.mjs"], consumerDirectory);
  console.log(`Verified external installation from ${basename(schema)} and ${basename(sdk)}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
