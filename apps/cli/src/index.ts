#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { correlate } from "@incidentiqhq/correlation";
import { SCHEMA_VERSION, type IncidentFixture, validateFixture } from "@incidentiqhq/event-schema";
import { applyMigrations, clearTenantData, createApiKey, createDatabase, getIncident, listApiKeys, listEvents, listIncidents, loadFixture, pruneTenantData, revokeApiKey, saveInvestigation } from "./database.js";
import { formatIncidentList, formatInvestigation } from "./format.js";

const args = process.argv.slice(2);
const [command, subcommand, target, option, format] = args;

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function optionalLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const label = value.trim();
  if (!label || label.length > 100) throw new Error("--label must contain between 1 and 100 characters");
  return label;
}

function positiveInteger(value: string | undefined, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  return parsed;
}

function tenantId(value: string | undefined): string {
  const tenant = value ?? "local";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(tenant)) throw new Error("--tenant must use 1-100 letters, numbers, dots, underscores, or hyphens");
  return tenant;
}

function retentionCutoff(value: string | undefined, now = Date.now()): string {
  const match = value?.match(/^(\d+)([dh])$/);
  if (!match) throw new Error("--older-than must use a positive duration such as 90d or 24h");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("--older-than must use a positive duration such as 90d or 24h");
  const milliseconds = amount * (match[2] === "d" ? 86_400_000 : 3_600_000);
  const cutoff = new Date(now - milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(cutoff.getTime())) throw new Error("--older-than is outside the supported date range");
  return cutoff.toISOString();
}

async function withDatabase(action: (database: ReturnType<typeof createDatabase>) => Promise<void>): Promise<void> {
  const database = createDatabase();
  try {
    await applyMigrations(database);
    await action(database);
  } finally {
    await database.destroy();
  }
}

async function readFixture(file: string): Promise<IncidentFixture> {
  const fixture: unknown = JSON.parse(await readFile(resolve(file), "utf8"));
  const result = validateFixture(fixture);
  if (!result.valid) throw new Error(`Invalid fixture:\n- ${result.errors.join("\n- ")}`);
  return fixture as IncidentFixture;
}

try {
  if (command === "version") {
    console.log(`incidentiq 0.8.1 (schema ${SCHEMA_VERSION})`);
  } else if (command === "api" && subcommand === "start") {
    const api = spawn(process.execPath, [fileURLToPath(new URL("../../../api/dist/src/main.js", import.meta.url))], { stdio: "inherit", env: process.env });
    await new Promise<void>((resolveStart, rejectStart) => api.once("exit", (code) => code === 0 ? resolveStart() : rejectStart(new Error(`API exited with code ${code}`))));
  } else if (command === "api" && subcommand === "health") {
    const response = await fetch(`${process.env.INCIDENTIQ_API_URL ?? "http://localhost:3000"}/v1/health/ready`);
    if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
    console.log(JSON.stringify(await response.json()));
  } else if (command === "keys" && subcommand === "create") {
    const scope = flag("--scope");
    if (scope !== "ingest" && scope !== "read") throw new Error("--scope must be ingest or read");
    const selectedTenant = tenantId(flag("--tenant"));
    const label = optionalLabel(flag("--label"));
    const expiresInDays = positiveInteger(flag("--expires-in-days"), "--expires-in-days", 3_650);
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : undefined;
    await withDatabase(async (database) => {
      const created = await createApiKey(database, scope, { tenantId: selectedTenant, label, expiresAt });
      console.log(`Created ${scope} key ${created.keyId} for tenant ${selectedTenant} (${created.visiblePrefix}…, expires ${expiresAt ?? "never"}).`);
      console.log(`API key (shown once): ${created.key}`);
    });
  } else if (command === "keys" && subcommand === "list") {
    await withDatabase(async (database) => console.log(JSON.stringify(await listApiKeys(database, hasFlag("--tenant") ? tenantId(flag("--tenant")) : undefined), null, 2)));
  } else if (command === "keys" && subcommand === "revoke" && target && hasFlag("--confirm")) {
    await withDatabase(async (database) => {
      const revoked = await revokeApiKey(database, target, hasFlag("--tenant") ? tenantId(flag("--tenant")) : undefined);
      if (!revoked) throw new Error(`Active API key not found: ${target}`);
      console.log(`Revoked ${revoked.scope} key ${revoked.key_id} for tenant ${revoked.tenant_id}.`);
    });
  } else if (command === "init") {
    await withDatabase(async () => console.log("PostgreSQL is ready and migrations are applied."));
  } else if (command === "data" && subcommand === "clear" && flag("--tenant") && hasFlag("--confirm")) {
    const selectedTenant = tenantId(flag("--tenant"));
    await withDatabase(async (database) => {
      const deleted = await clearTenantData(database, selectedTenant);
      console.log(`Cleared tenant ${selectedTenant}: ${deleted.incidents} incidents and ${deleted.events} events. API keys were preserved.`);
    });
  } else if (command === "data" && subcommand === "prune" && flag("--tenant") && flag("--older-than")) {
    const selectedTenant = tenantId(flag("--tenant"));
    const cutoff = retentionCutoff(flag("--older-than"));
    await withDatabase(async (database) => {
      const result = await pruneTenantData(database, selectedTenant, cutoff, hasFlag("--confirm"));
      console.log(`${result.deleted ? "Deleted" : "Dry run"}: ${result.incidents} incidents and ${result.events} unretained events for tenant ${selectedTenant} older than ${result.cutoff}. API keys were preserved.`);
      if (!result.deleted) console.log("Run the same command with --confirm to delete these records.");
    });
  } else if (command === "fixture" && subcommand === "validate" && target) {
    console.log(`Valid fixture: ${(await readFixture(target)).fixture_id}`);
  } else if (command === "fixture" && subcommand === "load" && target) {
    const fixture = await readFixture(target);
    await withDatabase(async (pool) => {
      const loaded = await loadFixture(pool, fixture);
      console.log(`Loaded ${fixture.fixture_id}: ${loaded.inserted} inserted, ${loaded.duplicates} duplicate.`);
    });
  } else if (command === "correlate" && subcommand) {
    const result = correlate(await readFixture(subcommand));
    if (target === "--save") {
      await withDatabase(async (pool) => {
        await saveInvestigation(pool, result);
      });
      console.log(`Saved incident: ${result.fixture_id}\n`);
    }
    console.log(formatInvestigation(result));
  } else if (command === "events" && subcommand === "list") {
    await withDatabase(async (pool) => console.log(JSON.stringify(await listEvents(pool), null, 2)));
  } else if (command === "incidents" && subcommand === "list" && (!target || (target === "--tenant" && option))) {
    await withDatabase(async (pool) => console.log(formatIncidentList(await listIncidents(pool, target === "--tenant" ? option : undefined))));
  } else if (command === "incidents" && subcommand === "explain" && target) {
    await withDatabase(async (pool) => {
      const incident = await getIncident(pool, target);
      if (!incident) throw new Error(`Incident not found: ${target}`);
      console.log(formatInvestigation(incident.investigation));
    });
  } else if (command === "incidents" && subcommand === "export" && target && option === "--format" && format === "json") {
    await withDatabase(async (pool) => {
      const incident = await getIncident(pool, target);
      if (!incident) throw new Error(`Incident not found: ${target}`);
      console.log(JSON.stringify(incident.investigation, null, 2));
    });
  } else {
    throw new Error("Usage: incidentiq version | api start | api health | keys create --scope ingest|read [--tenant <tenant>] [--label <label>] [--expires-in-days <days>] | keys list [--tenant <tenant>] | keys revoke <key-id> [--tenant <tenant>] --confirm | init | data clear --tenant <tenant> --confirm | data prune --tenant <tenant> --older-than <90d|24h> [--confirm] | fixture validate <file> | fixture load <file> | correlate <fixture> [--save] | events list | incidents list [--tenant <tenant>] | incidents explain <id> | incidents export <id> --format json");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
