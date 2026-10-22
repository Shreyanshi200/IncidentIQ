import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { IncidentFixture, NormalizedEvent } from "@incidentiq/event-schema";

export interface StoredEvent extends NormalizedEvent {
  created_at: string;
}

export function createPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl && existsSync(resolve(process.cwd(), ".env"))) {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
    databaseUrl = process.env.DATABASE_URL;
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required; see .env.example");
  return new Pool({ connectionString: databaseUrl });
}

export async function applyMigrations(pool: Pool, migrationsDirectory = resolve(process.cwd(), "infrastructure/postgres/migrations")): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const migrations: string[] = [];

    for (const file of files) {
      if (appliedVersions.has(file)) continue;
      await runMigration(client, file, await readFile(resolve(migrationsDirectory, file), "utf8"));
      migrations.push(file);
    }
    return migrations;
  } finally {
    client.release();
  }
}

async function runMigration(client: PoolClient, version: string, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function loadFixture(pool: Pool, fixture: IncidentFixture): Promise<{ inserted: number; duplicates: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const event of fixture.events) {
      const result = await client.query(
        `INSERT INTO source_events (
          event_id, occurred_at, received_at, tenant_id, environment, service, source, event_type,
          severity, version, trace_id, resource, attributes
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
        ) ON CONFLICT (event_id) DO NOTHING`,
        [
          event.event_id, event.occurred_at, event.received_at, event.tenant_id, event.environment,
          event.service, event.source, event.event_type, event.severity, event.version ?? null,
          event.trace_id ?? null, event.resource ?? null, JSON.stringify(event.attributes)
        ]
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { inserted, duplicates: fixture.events.length - inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvents(pool: Pool): Promise<StoredEvent[]> {
  const result = await pool.query<StoredEvent>(
    "SELECT event_id, occurred_at, received_at, tenant_id, environment, service, source, event_type, severity, version, trace_id, resource, attributes, created_at FROM source_events ORDER BY occurred_at, event_id"
  );
  return result.rows;
}
