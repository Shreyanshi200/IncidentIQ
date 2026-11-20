import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { correlate } from "@incidentiqhq/correlation";
import type { IncidentFixture, NormalizedEvent } from "@incidentiqhq/event-schema";
import { type Database, DatabaseService } from "./database.js";

const DEFAULT_WINDOW_MINUTES = 10;

export function configuredWindowMs(value: string | undefined, name: string): number {
  if (value === undefined) return DEFAULT_WINDOW_MINUTES * 60 * 1000;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${name} must be a positive number of minutes`);
  return minutes * 60 * 1000;
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function toEvent(row: {
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
}): NormalizedEvent {
  return {
    event_id: row.event_id,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    tenant_id: row.tenant_id,
    environment: row.environment,
    service: row.service,
    source: row.source,
    event_type: row.event_type,
    severity: row.severity,
    ...(row.version === null ? {} : { version: row.version }),
    ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
    ...(row.resource === null ? {} : { resource: row.resource }),
    attributes: row.attributes as Record<string, unknown>
  };
}

function incidentId(event: NormalizedEvent): string {
  const seed = [event.tenant_id, event.environment, event.service, event.event_id].join("\u0000");
  return `auto_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function isIncidentSignal(event: NormalizedEvent): boolean {
  return event.severity === "error" || event.severity === "critical";
}

@Injectable()
export class IncidentDetectionService {
  private readonly incidentGapMs: number;
  private readonly contextLookbackMs: number;

  constructor(private readonly database: DatabaseService) {
    this.incidentGapMs = configuredWindowMs(process.env.INCIDENTIQ_INCIDENT_GAP_MINUTES, "INCIDENTIQ_INCIDENT_GAP_MINUTES");
    this.contextLookbackMs = configuredWindowMs(process.env.INCIDENTIQ_CONTEXT_LOOKBACK_MINUTES, "INCIDENTIQ_CONTEXT_LOOKBACK_MINUTES");
  }

  // shortcut: detection is evaluated per accepted event; batch it when high-volume ingestion is introduced.
  async detect(event: NormalizedEvent, db: Kysely<Database> = this.database.db): Promise<void> {
    const eventAt = timestamp(event.occurred_at);
    const nearbyIncident = await db
      .selectFrom("incidents")
      .select(["incident_id", "started_at", "last_event_at"])
      .where("tenant_id", "=", event.tenant_id)
      .where("service", "=", event.service)
      .where("environment", "=", event.environment)
      .where("state", "=", "open")
      .where("last_event_at", ">=", isoTimestamp(eventAt - this.incidentGapMs))
      .where("started_at", "<=", isoTimestamp(eventAt + this.incidentGapMs))
      .orderBy("last_event_at", "desc")
      .executeTakeFirst();

    if (!nearbyIncident && !isIncidentSignal(event)) return;

    const id = nearbyIncident?.incident_id ?? incidentId(event);
    const startedAt = nearbyIncident?.started_at ?? event.occurred_at;
    const lastEventAt = isoTimestamp(Math.max(timestamp(nearbyIncident?.last_event_at ?? event.occurred_at), eventAt));
    const timeline = (await db
      .selectFrom("source_events")
      .selectAll()
      .where("tenant_id", "=", event.tenant_id)
      .where("service", "=", event.service)
      .where("environment", "=", event.environment)
      .where("occurred_at", ">=", isoTimestamp(timestamp(startedAt) - this.contextLookbackMs))
      .where("occurred_at", "<=", lastEventAt)
      .orderBy("occurred_at")
      .orderBy("event_id")
      .execute()).map(toEvent);
    const investigation = correlate({
      fixture_id: id,
      scenario: `Evidence automatically correlated for ${event.service} in ${event.environment}`,
      expected_cause: "automatic_detection",
      events: timeline
    } satisfies IncidentFixture, { eventWindowMs: this.contextLookbackMs });

    if (nearbyIncident) {
      await db
        .updateTable("incidents")
        .set({ last_event_at: lastEventAt, event_count: timeline.length, leading_cause: investigation.leading_cause, confidence: investigation.confidence, investigation, updated_at: new Date().toISOString() })
        .where("incident_id", "=", id)
        .execute();
    } else {
      await db
        .insertInto("incidents")
        .values({
          incident_id: id,
          tenant_id: event.tenant_id,
          service: event.service,
          environment: event.environment,
          state: "open",
          started_at: startedAt,
          last_event_at: lastEventAt,
          event_count: timeline.length,
          leading_cause: investigation.leading_cause,
          confidence: investigation.confidence,
          investigation
        })
        .execute();
    }

    await db
      .insertInto("incident_events")
      .values(timeline.map((item) => ({ incident_id: id, event_id: item.event_id })))
      .onConflict((conflict) => conflict.columns(["incident_id", "event_id"]).doNothing())
      .execute();
  }
}
