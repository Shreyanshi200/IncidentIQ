import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Generated, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { IncidentFixture, NormalizedEvent } from "@incidentiqhq/event-schema";
import type { CorrelationResult } from "@incidentiqhq/correlation";

export interface StoredEvent extends NormalizedEvent {
  created_at: string;
}

export interface IncidentSummary {
  incident_id: string;
  tenant_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  last_event_at: string;
  event_count: number;
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
  tenant_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  last_event_at: string;
  event_count: number;
  leading_cause: string;
  confidence: string;
  investigation: CorrelationResult;
  updated_at: Generated<string>;
}

interface IncidentEventsTable {
  incident_id: string;
  event_id: string;
  linked_at: Generated<string>;
}

interface ApiKeysTable {
  key_id: string;
  key_hash: string;
  visible_prefix: string;
  scope: string;
  tenant_id: string;
  label: string | null;
  created_at: Generated<string>;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeySummary {
  key_id: string;
  visible_prefix: string;
  scope: string;
  tenant_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface RetentionResult {
  tenant_id: string;
  cutoff: string;
  incidents: number;
  events: number;
  deleted: boolean;
}

interface SchemaMigrationsTable {
  version: string;
  applied_at: Generated<string>;
}

interface Database {
  source_events: SourceEventsTable;
  incidents: IncidentsTable;
  incident_events: IncidentEventsTable;
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

export async function clearTenantData(db: Kysely<Database>, tenantId: string): Promise<{ incidents: number; events: number }> {
  return db.transaction().execute(async (transaction) => {
    const incidents = await transaction.deleteFrom("incidents").where("tenant_id", "=", tenantId).returning("incident_id").execute();
    const events = await transaction.deleteFrom("source_events").where("tenant_id", "=", tenantId).returning("event_id").execute();
    return { incidents: incidents.length, events: events.length };
  });
}

export async function saveInvestigation(db: Kysely<Database>, result: CorrelationResult): Promise<IncidentSummary> {
  const startedAt = result.timeline[0];
  const affectedEvent = result.timeline.at(-1);
  if (!startedAt || !affectedEvent) throw new Error("An investigation requires at least one event");
  return db.transaction().execute(async (transaction) => {
    const incident = await transaction
      .insertInto("incidents")
      .values({
        incident_id: result.fixture_id,
        tenant_id: affectedEvent.tenant_id,
        service: affectedEvent.service,
        environment: affectedEvent.environment,
        state: "open",
        started_at: startedAt.occurred_at,
        last_event_at: affectedEvent.occurred_at,
        event_count: result.timeline.length,
        leading_cause: result.leading_cause,
        confidence: result.confidence,
        investigation: result
      })
      .onConflict((conflict) => conflict.column("incident_id").doUpdateSet({
        tenant_id: affectedEvent.tenant_id,
        service: affectedEvent.service,
        environment: affectedEvent.environment,
        last_event_at: affectedEvent.occurred_at,
        event_count: result.timeline.length,
        leading_cause: result.leading_cause,
        confidence: result.confidence,
        investigation: result,
        updated_at: sql`now()`
      }))
      .returning(["incident_id", "tenant_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence"])
      .executeTakeFirstOrThrow();

    await transaction.deleteFrom("incident_events").where("incident_id", "=", result.fixture_id).execute();
    await transaction
      .insertInto("incident_events")
      .values(result.timeline.map((event) => ({ incident_id: result.fixture_id, event_id: event.event_id })))
      .execute();
    return incident;
  });
}

export async function listIncidents(db: Kysely<Database>, tenantId?: string): Promise<IncidentSummary[]> {
  let query = db.selectFrom("incidents").select(["incident_id", "tenant_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence"]);
  if (tenantId) query = query.where("tenant_id", "=", tenantId);
  return query.orderBy("started_at", "desc").orderBy("incident_id").execute();
}

export async function getIncident(db: Kysely<Database>, incidentId: string): Promise<StoredIncident | undefined> {
  return db.selectFrom("incidents").select(["incident_id", "tenant_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence", "investigation"]).where("incident_id", "=", incidentId).executeTakeFirst();
}

export async function createApiKey(
  db: Kysely<Database>,
  scope: "ingest" | "read",
  options: { tenantId?: string; label?: string; expiresAt?: string } = {}
): Promise<{ key: string; keyId: string; visiblePrefix: string }> {
  const key = `iiq_${randomBytes(24).toString("base64url")}`;
  const keyId = randomUUID();
  const keyHash = createHash("sha256").update(key).digest("hex");
  const visiblePrefix = key.slice(0, 12);
  await db.insertInto("api_keys").values({
    key_id: keyId,
    key_hash: keyHash,
    visible_prefix: visiblePrefix,
    scope,
    tenant_id: options.tenantId ?? "local",
    label: options.label ?? null,
    expires_at: options.expiresAt ?? null,
    revoked_at: null
  }).execute();
  return { key, keyId, visiblePrefix };
}

export function createIngestionKey(db: Kysely<Database>): Promise<string> {
  return createApiKey(db, "ingest").then(({ key }) => key);
}

export async function listApiKeys(db: Kysely<Database>, tenantId?: string): Promise<ApiKeySummary[]> {
  let query = db.selectFrom("api_keys").select(["key_id", "visible_prefix", "scope", "tenant_id", "label", "created_at", "expires_at", "revoked_at"]);
  if (tenantId) query = query.where("tenant_id", "=", tenantId);
  const rows = await query.orderBy("created_at", "desc").orderBy("key_id").execute();
  return rows.map((row) => ({
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString()
  }));
}

export async function revokeApiKey(db: Kysely<Database>, keyId: string, tenantId?: string): Promise<ApiKeySummary | undefined> {
  let query = db
    .updateTable("api_keys")
    .set({ revoked_at: sql`now()` })
    .where("key_id", "=", keyId)
    .where("revoked_at", "is", null);
  if (tenantId) query = query.where("tenant_id", "=", tenantId);
  const row = await query
    .returning(["key_id", "visible_prefix", "scope", "tenant_id", "label", "created_at", "expires_at", "revoked_at"])
    .executeTakeFirst();
  return row ? {
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString()
  } : undefined;
}

export async function pruneTenantData(db: Kysely<Database>, tenantId: string, cutoff: string, confirm = false): Promise<RetentionResult> {
  return db.transaction().execute(async (transaction) => {
    const expiredIncidents = await transaction
      .selectFrom("incidents")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("last_event_at", "<", cutoff)
      .executeTakeFirstOrThrow();
    const retainedEventIds = transaction
      .selectFrom("incident_events")
      .innerJoin("incidents", "incidents.incident_id", "incident_events.incident_id")
      .select("incident_events.event_id")
      .where("incidents.tenant_id", "=", tenantId)
      .where("incidents.last_event_at", ">=", cutoff);
    const expiredEvents = await transaction
      .selectFrom("source_events")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("occurred_at", "<", cutoff)
      .where("event_id", "not in", retainedEventIds)
      .executeTakeFirstOrThrow();

    const result: RetentionResult = {
      tenant_id: tenantId,
      cutoff,
      incidents: Number(expiredIncidents.count),
      events: Number(expiredEvents.count),
      deleted: confirm
    };
    if (!confirm) return result;

    const deletedIncidents = await transaction.deleteFrom("incidents").where("tenant_id", "=", tenantId).where("last_event_at", "<", cutoff).executeTakeFirst();
    const deletedEvents = await transaction
      .deleteFrom("source_events")
      .where("tenant_id", "=", tenantId)
      .where("occurred_at", "<", cutoff)
      .where("event_id", "not in", transaction.selectFrom("incident_events").select("event_id"))
      .executeTakeFirst();
    return { ...result, incidents: Number(deletedIncidents.numDeletedRows), events: Number(deletedEvents.numDeletedRows) };
  });
}
