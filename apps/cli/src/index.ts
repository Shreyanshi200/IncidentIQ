#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { correlate } from "@incidentiq/correlation";
import { SCHEMA_VERSION, type IncidentFixture, validateFixture } from "@incidentiq/event-schema";
import { applyMigrations, createDatabase, createIngestionKey, getIncident, listEvents, listIncidents, loadFixture, saveInvestigation } from "./database.js";
import { formatIncidentList, formatInvestigation } from "./format.js";

const [command, subcommand, target, option, format] = process.argv.slice(2);

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
    console.log(`incidentiq 0.4.0 (schema ${SCHEMA_VERSION})`);
  } else if (command === "api" && subcommand === "start") {
    const api = spawn(process.execPath, [fileURLToPath(new URL("../../../api/dist/src/main.js", import.meta.url))], { stdio: "inherit", env: process.env });
    await new Promise<void>((resolveStart, rejectStart) => api.once("exit", (code) => code === 0 ? resolveStart() : rejectStart(new Error(`API exited with code ${code}`))));
  } else if (command === "api" && subcommand === "health") {
    const response = await fetch(`${process.env.INCIDENTIQ_API_URL ?? "http://localhost:3000"}/v1/health`);
    if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
    console.log(JSON.stringify(await response.json()));
  } else if (command === "keys" && subcommand === "create" && target === "--scope" && option === "ingest") {
    await withDatabase(async (pool) => console.log(`Ingestion API key (shown once): ${await createIngestionKey(pool)}`));
  } else if (command === "init") {
    await withDatabase(async () => console.log("PostgreSQL is ready and migrations are applied."));
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
  } else if (command === "incidents" && subcommand === "list") {
    await withDatabase(async (pool) => console.log(formatIncidentList(await listIncidents(pool))));
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
    throw new Error("Usage: incidentiq version | api start | api health | keys create --scope ingest | init | fixture validate <file> | fixture load <file> | correlate <fixture> [--save] | events list | incidents list | incidents explain <id> | incidents export <id> --format json");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
