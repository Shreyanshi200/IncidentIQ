import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "./database.js";
import { DatabaseService } from "./database.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_RETRY_MS = 300_000;

export interface ClickHouseConfig {
  url: URL;
  database: string;
  username: string;
  password: string;
  batchSize: number;
  flushIntervalMs: number;
  hotRetentionDays?: number;
  pruneIntervalMs: number;
}

interface OutboxRecord {
  record_type: "event" | "incident";
  record_id: string;
  attempt_count: number;
}

export interface ArchivedIncidentFilters {
  service?: string;
  environment?: string;
  cause?: string;
  from?: string;
  to?: string;
}

export interface ArchivedIncidentRecord {
  incident_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  last_event_at: string;
  event_count: number;
  leading_cause: string;
  confidence: string;
  investigation: unknown;
}

interface ArchivedIncidentQueryRow {
  incident_id: string;
  service: string;
  environment: string;
  state: string;
  started_at_ms: number | string;
  last_event_at_ms: number | string;
  event_count: number | string;
  leading_cause: string;
  confidence: string;
  investigation_json: string;
}

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return positiveInteger(value, 1, name, maximum);
}

export function clickHouseConfig(environment: NodeJS.ProcessEnv = process.env): ClickHouseConfig | undefined {
  const rawUrl = environment.CLICKHOUSE_URL?.trim();
  if (!rawUrl) return undefined;
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLICKHOUSE_URL must use http or https");
  const database = environment.CLICKHOUSE_DATABASE?.trim() || "incidentiq";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) throw new Error("CLICKHOUSE_DATABASE must be a valid unquoted identifier");
  return {
    url,
    database,
    username: environment.CLICKHOUSE_USERNAME?.trim() || "default",
    password: environment.CLICKHOUSE_PASSWORD ?? "",
    batchSize: positiveInteger(environment.INCIDENTIQ_CLICKHOUSE_BATCH_SIZE, DEFAULT_BATCH_SIZE, "INCIDENTIQ_CLICKHOUSE_BATCH_SIZE", 10_000),
    flushIntervalMs: positiveInteger(environment.INCIDENTIQ_CLICKHOUSE_FLUSH_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS, "INCIDENTIQ_CLICKHOUSE_FLUSH_INTERVAL_MS", 300_000),
    hotRetentionDays: optionalPositiveInteger(environment.INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS, "INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS", 3_650),
    pruneIntervalMs: positiveInteger(environment.INCIDENTIQ_POSTGRES_PRUNE_INTERVAL_MINUTES, 60, "INCIDENTIQ_POSTGRES_PRUNE_INTERVAL_MINUTES", 1_440) * 60_000
  };
}

export function archiveRetryDelay(attemptCount: number): number {
  return Math.min(1_000 * 2 ** Math.min(attemptCount, 8), MAX_RETRY_MS);
}

export async function pruneArchivedHotStore(db: Kysely<Database>, cutoff: string): Promise<{ incidents: number; events: number }> {
  return db.transaction().execute(async (transaction) => {
    const incidents = await transaction
      .deleteFrom("incidents")
      .where("last_event_at", "<", cutoff)
      .where("clickhouse_archived_at", "is not", null)
      .executeTakeFirst();
    const events = await transaction
      .deleteFrom("source_events")
      .where("occurred_at", "<", cutoff)
      .where("clickhouse_archived_at", "is not", null)
      .where("event_id", "not in", transaction.selectFrom("incident_events").select("event_id"))
      .executeTakeFirst();
    return { incidents: Number(incidents.numDeletedRows), events: Number(events.numDeletedRows) };
  });
}

export class ClickHouseHttpClient {
  constructor(private readonly config: ClickHouseConfig, private readonly fetchRequest: typeof fetch = fetch) {}

  async initialize(): Promise<void> {
    await this.execute(`CREATE TABLE IF NOT EXISTS ${this.config.database}.source_events (
      event_id String,
      occurred_at DateTime64(3, 'UTC'),
      received_at DateTime64(3, 'UTC'),
      tenant_id LowCardinality(String),
      environment LowCardinality(String),
      service LowCardinality(String),
      source LowCardinality(String),
      event_type LowCardinality(String),
      severity LowCardinality(String),
      version Nullable(String),
      trace_id Nullable(String),
      resource Nullable(String),
      attributes_json String,
      archived_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(archived_at)
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY (tenant_id, environment, service, occurred_at, event_id)`);
    await this.execute(`CREATE TABLE IF NOT EXISTS ${this.config.database}.incidents (
      incident_id String,
      tenant_id LowCardinality(String),
      service LowCardinality(String),
      environment LowCardinality(String),
      state LowCardinality(String),
      started_at DateTime64(3, 'UTC'),
      last_event_at DateTime64(3, 'UTC'),
      event_count UInt32,
      leading_cause LowCardinality(String),
      confidence LowCardinality(String),
      investigation_json String,
      updated_at DateTime64(3, 'UTC'),
      archived_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at)
    PARTITION BY toYYYYMM(started_at)
    ORDER BY (tenant_id, incident_id)`);
  }

  async insert(table: "source_events" | "incidents", rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.execute(
      `INSERT INTO ${this.config.database}.${table} FORMAT JSONEachRow`,
      rows.map((row) => JSON.stringify(row)).join("\n")
    );
  }

  async query<T>(query: string, parameters: Record<string, string> = {}): Promise<T[]> {
    const response = await this.request(`${query} FORMAT JSONEachRow`, undefined, parameters);
    const body = await response.text();
    return body.trim() ? body.trim().split("\n").map((line) => JSON.parse(line) as T) : [];
  }

  private async execute(query: string, body?: string): Promise<void> {
    await this.request(query, body);
  }

  private async request(query: string, body?: string, parameters: Record<string, string> = {}): Promise<Response> {
    const url = new URL(this.config.url);
    url.searchParams.set("query", query);
    url.searchParams.set("date_time_input_format", "best_effort");
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(`param_${name}`, value);
    const response = await this.fetchRequest(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
        ...(body === undefined ? {} : { "content-type": "application/x-ndjson" })
      },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`ClickHouse request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    return response;
  }
}

@Injectable()
export class ClickHouseArchiveService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly config = clickHouseConfig();
  private readonly client = this.config ? new ClickHouseHttpClient(this.config) : undefined;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private initialized = false;
  private failureCount = 0;
  private nextFlushAt = 0;
  private nextPruneAt = 0;
  private stopping = false;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (!this.config) return;
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    this.timer.unref();
    void this.flush();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.flushing;
  }

  get enabled(): boolean {
    return Boolean(this.config);
  }

  get hotRetentionDays(): number | undefined {
    return this.config?.hotRetentionDays;
  }

  async archivedIncidents(
    tenantId: string,
    filters: ArchivedIncidentFilters,
    cursor?: { last_event_at: string; incident_id: string },
    limit = 26
  ): Promise<ArchivedIncidentRecord[]> {
    if (!this.client || !this.config) return [];
    await this.ensureInitialized();
    const conditions: string[] = [];
    const parameters: Record<string, string> = { tenant: tenantId };
    if (filters.service) {
      conditions.push("service = {service:String}");
      parameters.service = filters.service;
    }
    if (filters.environment) {
      conditions.push("environment = {environment:String}");
      parameters.environment = filters.environment;
    }
    if (filters.cause) {
      conditions.push("leading_cause = {cause:String}");
      parameters.cause = filters.cause;
    }
    if (filters.from) {
      conditions.push("last_event_at_ms >= {from_ms:Int64}");
      parameters.from_ms = String(Date.parse(filters.from));
    }
    const configuredCutoff = this.config.hotRetentionDays
      ? Date.now() - this.config.hotRetentionDays * 86_400_000
      : undefined;
    const requestedTo = filters.to ? Date.parse(filters.to) : undefined;
    const effectiveTo = configuredCutoff === undefined
      ? requestedTo
      : requestedTo === undefined ? configuredCutoff : Math.min(configuredCutoff, requestedTo);
    if (effectiveTo !== undefined) {
      conditions.push("last_event_at_ms < {to_ms:Int64}");
      parameters.to_ms = String(effectiveTo);
    }
    if (cursor) {
      conditions.push("(last_event_at_ms < {cursor_ms:Int64} OR (last_event_at_ms = {cursor_ms:Int64} AND incident_id > {cursor_id:String}))");
      parameters.cursor_ms = String(Date.parse(cursor.last_event_at));
      parameters.cursor_id = cursor.incident_id;
    }

    const rows = await this.client.query<ArchivedIncidentQueryRow>(`${this.archivedIncidentSelect()}
      WHERE tenant_id = {tenant:String}
      GROUP BY incident_id
      ${conditions.length > 0 ? `HAVING ${conditions.join(" AND ")}` : ""}
      ORDER BY last_event_at_ms DESC, incident_id ASC
      LIMIT ${Math.max(1, Math.min(limit, 100))}`, parameters);
    return rows.map((row) => this.mapArchivedIncident(row));
  }

  async archivedIncident(tenantId: string, incidentId: string): Promise<ArchivedIncidentRecord | undefined> {
    if (!this.client) return undefined;
    await this.ensureInitialized();
    const rows = await this.client.query<ArchivedIncidentQueryRow>(`${this.archivedIncidentSelect()}
      WHERE tenant_id = {tenant:String} AND incident_id = {incident_id:String}
      GROUP BY incident_id
      LIMIT 1`, { tenant: tenantId, incident_id: incidentId });
    return rows[0] ? this.mapArchivedIncident(rows[0]) : undefined;
  }

  async enqueue(db: Kysely<Database> | Transaction<Database>, eventId: string, tenantId: string, incidentId?: string): Promise<void> {
    if (!this.config) return;
    await db
      .insertInto("clickhouse_archive_outbox")
      .values([
        { record_type: "event", record_id: eventId, tenant_id: tenantId, last_error: null },
        ...(incidentId ? [{ record_type: "incident" as const, record_id: incidentId, tenant_id: tenantId, last_error: null }] : [])
      ])
      .onConflict((conflict) => conflict.columns(["record_type", "record_id"]).doUpdateSet({
        next_attempt_at: new Date().toISOString(),
        attempt_count: 0,
        last_error: null
      }))
      .execute();
    if (incidentId) await db.updateTable("incidents").set({ clickhouse_archived_at: null }).where("incident_id", "=", incidentId).execute();
  }

  wake(): void {
    if (this.config && !this.stopping) void this.flush();
  }

  flush(): Promise<void> {
    if (!this.client || !this.config || this.stopping) return Promise.resolve();
    if (Date.now() < this.nextFlushAt) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.flushBatch()
      .then(() => {
        this.failureCount = 0;
        this.nextFlushAt = 0;
      })
      .catch((error: unknown) => {
        this.nextFlushAt = Date.now() + archiveRetryDelay(this.failureCount++);
        if (!this.stopping) console.warn(`ClickHouse archive delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(() => this.stopping ? undefined : this.pruneIfDue().catch((error: unknown) => {
        console.warn(`PostgreSQL hot-retention pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }))
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  private async flushBatch(): Promise<void> {
    if (!this.client || !this.config) return;
    await this.ensureInitialized();
    const pending = await this.database.db
      .selectFrom("clickhouse_archive_outbox")
      .select(["record_type", "record_id", "attempt_count"])
      .where("next_attempt_at", "<=", new Date().toISOString())
      .orderBy("queued_at")
      .limit(this.config.batchSize)
      .execute() as OutboxRecord[];
    if (pending.length === 0) return;

    try {
      const eventIds = pending.filter((item) => item.record_type === "event").map((item) => item.record_id);
      const incidentIds = pending.filter((item) => item.record_type === "incident").map((item) => item.record_id);
      const events = eventIds.length === 0 ? [] : await this.database.db.selectFrom("source_events").selectAll().where("event_id", "in", eventIds).execute();
      const incidents = incidentIds.length === 0 ? [] : await this.database.db.selectFrom("incidents").selectAll().where("incident_id", "in", incidentIds).execute();
      await this.client.insert("source_events", events.map((event) => ({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        received_at: event.received_at,
        tenant_id: event.tenant_id,
        environment: event.environment,
        service: event.service,
        source: event.source,
        event_type: event.event_type,
        severity: event.severity,
        version: event.version,
        trace_id: event.trace_id,
        resource: event.resource,
        attributes_json: JSON.stringify(event.attributes)
      })));
      await this.client.insert("incidents", incidents.map((incident) => ({
        incident_id: incident.incident_id,
        tenant_id: incident.tenant_id,
        service: incident.service,
        environment: incident.environment,
        state: incident.state,
        started_at: incident.started_at,
        last_event_at: incident.last_event_at,
        event_count: incident.event_count,
        leading_cause: incident.leading_cause,
        confidence: incident.confidence,
        investigation_json: JSON.stringify(incident.investigation),
        updated_at: incident.updated_at
      })));
      const archivedAt = new Date().toISOString();
      await this.database.db.transaction().execute(async (transaction) => {
        if (eventIds.length > 0) await transaction.updateTable("source_events").set({ clickhouse_archived_at: archivedAt }).where("event_id", "in", eventIds).execute();
        if (incidentIds.length > 0) await transaction.updateTable("incidents").set({ clickhouse_archived_at: archivedAt }).where("incident_id", "in", incidentIds).execute();
        await transaction
          .deleteFrom("clickhouse_archive_outbox")
          .where(({ eb, or }) => or(pending.map((item) => eb.and([eb("record_type", "=", item.record_type), eb("record_id", "=", item.record_id)]))))
          .execute();
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      await Promise.all(pending.map((item) => this.database.db
        .updateTable("clickhouse_archive_outbox")
        .set({
          attempt_count: item.attempt_count + 1,
          next_attempt_at: new Date(Date.now() + archiveRetryDelay(item.attempt_count)).toISOString(),
          last_error: message
        })
        .where("record_type", "=", item.record_type)
        .where("record_id", "=", item.record_id)
        .execute()));
      throw error;
    }
  }

  private async pruneIfDue(): Promise<void> {
    if (!this.config?.hotRetentionDays || Date.now() < this.nextPruneAt) return;
    this.nextPruneAt = Date.now() + this.config.pruneIntervalMs;
    const cutoff = new Date(Date.now() - this.config.hotRetentionDays * 86_400_000).toISOString();
    const deleted = await pruneArchivedHotStore(this.database.db, cutoff);
    if (deleted.incidents > 0 || deleted.events > 0) console.log(JSON.stringify({ level: "info", message: "postgres_hot_retention", cutoff, ...deleted }));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.client || this.initialized) return;
    await this.client.initialize();
    this.initialized = true;
  }

  private archivedIncidentSelect(): string {
    return `SELECT
      incident_id,
      argMax(service, updated_at) AS service,
      argMax(environment, updated_at) AS environment,
      argMax(state, updated_at) AS state,
      toUnixTimestamp64Milli(argMax(started_at, updated_at)) AS started_at_ms,
      toUnixTimestamp64Milli(argMax(last_event_at, updated_at)) AS last_event_at_ms,
      argMax(event_count, updated_at) AS event_count,
      argMax(leading_cause, updated_at) AS leading_cause,
      argMax(confidence, updated_at) AS confidence,
      argMax(investigation_json, updated_at) AS investigation_json
      FROM ${this.config!.database}.incidents`;
  }

  private mapArchivedIncident(row: ArchivedIncidentQueryRow): ArchivedIncidentRecord {
    return {
      incident_id: row.incident_id,
      service: row.service,
      environment: row.environment,
      state: row.state,
      started_at: new Date(Number(row.started_at_ms)).toISOString(),
      last_event_at: new Date(Number(row.last_event_at_ms)).toISOString(),
      event_count: Number(row.event_count),
      leading_cause: row.leading_cause,
      confidence: row.confidence,
      investigation: JSON.parse(row.investigation_json) as unknown
    };
  }
}
