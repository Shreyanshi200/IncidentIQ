import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Generated, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { IncidentFixture, NormalizedEvent } from "@incidentiq/event-schema";
import type { CorrelationResult } from "@incidentiq/correlation";

export interface StoredEvent extends NormalizedEvent {
  created_at: string;
}

export interface IncidentSummary {
  incident_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  leading_cause: string;
  confidence: string;
}

export interface StoredIncident extends IncidentSummary {
  investigation: CorrelationResult;
}

interface SourceEventsTable {
  event_id: string;
  occurred_at: string;
  received_at: string;
  tenant_id: string;
  environment: string;
  service: string;
  source: NormalizedEvent["source"];
  event_type: string;
  severity: NormalizedEvent["severity"];
  version: string | null;
  trace_id: string | null;
  resource: string | null;
  attributes: Record<string, unknown>;
  created_at: Generated<string>;
}

interface IncidentsTable {
  incident_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  leading_cause: string;
  confidence: string;
  investigation: CorrelationResult;
  updated_at: Generated<string>;
}

interface ApiKeysTable {
  key_id: string;
  key_hash: string;
  visible_prefix: string;
  scope: string;
  tenant_id: string;
  created_at: Generated<string>;
  revoked_at: string | null;
}

interface SchemaMigrationsTable {
  version: string;
  applied_at: Generated<string>;
}

interface Database {
  source_events: SourceEventsTable;
  incidents: IncidentsTable;
  api_keys: ApiKeysTable;
  schema_migrations: SchemaMigrationsTable;
}

export function createDatabase(databaseUrl = process.env.DATABASE_URL): Kysely<Database> {
  if (!databaseUrl && existsSync(resolve(process.cwd(), ".env"))) {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
    databaseUrl = process.env.DATABASE_URL;
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required; see .env.example");
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
}

export async function applyMigrations(db: Kysely<Database>, migrationsDirectory = resolve(process.cwd(), "infrastructure/postgres/migrations")): Promise<string[]> {
  await db.schema
    .createTable("schema_migrations")
    .ifNotExists()
    .addColumn("version", "text", (column) => column.primaryKey())
    .addColumn("applied_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  const appliedVersions = new Set((await db.selectFrom("schema_migrations").select("version").execute()).map((row) => row.version));
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: string[] = [];

  for (const file of files) {
    if (appliedVersions.has(file)) continue;
    await db.transaction().execute(async (transaction) => {
      await sql.raw(await readFile(resolve(migrationsDirectory, file), "utf8")).execute(transaction);
      await transaction.insertInto("schema_migrations").values({ version: file }).execute();
    });
    migrations.push(file);
  }
  return migrations;
}

export async function loadFixture(db: Kysely<Database>, fixture: IncidentFixture): Promise<{ inserted: number; duplicates: number }> {
  const inserted = await db.transaction().execute(async (transaction) => {
    const saved = await transaction
      .insertInto("source_events")
      .values(fixture.events.map((event) => ({ ...event, version: event.version ?? null, trace_id: event.trace_id ?? null, resource: event.resource ?? null })))
      .onConflict((conflict) => conflict.column("event_id").doNothing())
      .returning("event_id")
      .execute();
    return saved.length;
  });
  return { inserted, duplicates: fixture.events.length - inserted };
}

export async function listEvents(db: Kysely<Database>): Promise<StoredEvent[]> {
  const events = await db.selectFrom("source_events").selectAll().orderBy("occurred_at", "desc").orderBy("event_id", "desc").execute();
  return events.map(({ version, trace_id, resource, ...event }) => ({
    ...event,
    ...(version === null ? {} : { version }),
    ...(trace_id === null ? {} : { trace_id }),
    ...(resource === null ? {} : { resource })
  }));
}

export async function saveInvestigation(db: Kysely<Database>, result: CorrelationResult): Promise<IncidentSummary> {
  const startedAt = result.timeline[0];
  const affectedEvent = result.timeline.at(-1);
  if (!startedAt || !affectedEvent) throw new Error("An investigation requires at least one event");
  return db
    .insertInto("incidents")
    .values({
      incident_id: result.fixture_id,
      service: affectedEvent.service,
      environment: affectedEvent.environment,
      state: "open",
      started_at: startedAt.occurred_at,
      leading_cause: result.leading_cause,
      confidence: result.confidence,
      investigation: result
    })
    .onConflict((conflict) => conflict.column("incident_id").doUpdateSet({
      service: affectedEvent.service,
      environment: affectedEvent.environment,
      leading_cause: result.leading_cause,
      confidence: result.confidence,
      investigation: result,
      updated_at: sql`now()`
    }))
    .returning(["incident_id", "service", "environment", "state", "started_at", "leading_cause", "confidence"])
    .executeTakeFirstOrThrow();
}

export async function listIncidents(db: Kysely<Database>): Promise<IncidentSummary[]> {
  return db.selectFrom("incidents").select(["incident_id", "service", "environment", "state", "started_at", "leading_cause", "confidence"]).orderBy("started_at", "desc").orderBy("incident_id").execute();
}

export async function getIncident(db: Kysely<Database>, incidentId: string): Promise<StoredIncident | undefined> {
  return db.selectFrom("incidents").select(["incident_id", "service", "environment", "state", "started_at", "leading_cause", "confidence", "investigation"]).where("incident_id", "=", incidentId).executeTakeFirst();
}

export async function createIngestionKey(db: Kysely<Database>): Promise<string> {
  const key = `iiq_${randomBytes(24).toString("base64url")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  await db.insertInto("api_keys").values({ key_id: randomUUID(), key_hash: keyHash, visible_prefix: key.slice(0, 12), scope: "ingest", tenant_id: "local", revoked_at: null }).execute();
  return key;
}
