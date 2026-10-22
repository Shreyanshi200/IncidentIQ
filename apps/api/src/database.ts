import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { type Generated, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

interface SourceEventsTable {
  event_id: string;
  occurred_at: string;
  received_at: string;
  tenant_id: string;
  environment: string;
  service: string;
  source: string;
  event_type: string;
  severity: string;
  version: string | null;
  trace_id: string | null;
  resource: string | null;
  attributes: unknown;
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

interface Database {
  source_events: SourceEventsTable;
  api_keys: ApiKeysTable;
}

function databaseUrl(): string {
  if (!process.env.DATABASE_URL && existsSync(resolve(process.cwd(), ".env"))) process.loadEnvFile(resolve(process.cwd(), ".env"));
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
