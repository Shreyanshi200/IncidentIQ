import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { type Generated, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { NormalizedEvent } from "@incidentiqhq/event-schema";

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
  attributes: unknown;
  clickhouse_archived_at: Generated<string | null>;
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
  investigation: unknown;
  updated_at: Generated<string>;
  clickhouse_archived_at: Generated<string | null>;
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

export interface ClickHouseArchiveOutboxTable {
  record_type: "event" | "incident";
  record_id: string;
  tenant_id: string;
  queued_at: Generated<string>;
  next_attempt_at: Generated<string>;
  attempt_count: Generated<number>;
  last_error: string | null;
}

export interface Database {
  source_events: SourceEventsTable;
  incidents: IncidentsTable;
  incident_events: IncidentEventsTable;
  api_keys: ApiKeysTable;
  clickhouse_archive_outbox: ClickHouseArchiveOutboxTable;
}

export function databaseEnvPaths(cwd = process.cwd()): string[] {
  return [resolve(cwd, ".env"), resolve(cwd, "..", "..", ".env")];
}

export function loadEnvironment(cwd = process.cwd()): void {
  const envFile = databaseEnvPaths(cwd).find((path) => existsSync(path));
  if (envFile) process.loadEnvFile(envFile);
}

function databaseUrl(): string {
  loadEnvironment();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; see .env.example");
  return process.env.DATABASE_URL;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl() }) }) });

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
