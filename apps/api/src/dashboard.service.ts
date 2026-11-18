import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { DatabaseService } from "./database.js";
import { DashboardSessionService } from "./dashboard-session.service.js";

export interface DashboardOverview {
  services: Array<{ service: string; environments: string[]; event_count: number; last_event_at: string; sources: string[] }>;
  environments: Array<{ environment: string; service_count: number; event_count: number; last_event_at: string }>;
  integrations: Array<{ source: string; event_count: number; last_event_at: string }>;
}

function mostRecent(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService, private readonly sessions: DashboardSessionService) {}

  async overview(cookie: string | undefined): Promise<DashboardOverview> {
    const tenantId = await this.sessions.tenantId(cookie);

    // shortcut: aggregate source_events directly; add tenant rollups when evidence volume outgrows a single operator.
    const [serviceRows, environments, integrations] = await Promise.all([
      this.database.db
        .selectFrom("source_events")
        .select([
          "service",
          "environment",
          sql<number>`count(*)`.as("event_count"),
          sql<string>`max(occurred_at)::text`.as("last_event_at"),
          sql<string>`array_to_string(array_agg(distinct source order by source), ',')`.as("sources")
        ])
        .where("tenant_id", "=", tenantId)
        .groupBy(["service", "environment"])
        .orderBy("service")
        .orderBy("environment")
        .execute(),
      this.database.db
        .selectFrom("source_events")
        .select([
          "environment",
          sql<number>`count(distinct service)`.as("service_count"),
          sql<number>`count(*)`.as("event_count"),
          sql<string>`max(occurred_at)::text`.as("last_event_at")
        ])
        .where("tenant_id", "=", tenantId)
        .groupBy("environment")
        .orderBy("environment")
        .execute(),
      this.database.db
        .selectFrom("source_events")
        .select([
          "source",
          sql<number>`count(*)`.as("event_count"),
          sql<string>`max(occurred_at)::text`.as("last_event_at")
        ])
        .where("tenant_id", "=", tenantId)
        .groupBy("source")
        .orderBy("source")
        .execute()
    ]);

    const groupedServices = new Map<string, DashboardOverview["services"][number]>();
    for (const row of serviceRows) {
      const lastEventAt = isoTimestamp(row.last_event_at);
      const existing = groupedServices.get(row.service);
      if (existing) {
        existing.environments.push(row.environment);
        existing.event_count += Number(row.event_count);
        existing.last_event_at = mostRecent(existing.last_event_at, lastEventAt);
        for (const source of row.sources.split(",")) if (!existing.sources.includes(source)) existing.sources.push(source);
      } else {
        groupedServices.set(row.service, {
          service: row.service,
          environments: [row.environment],
          event_count: Number(row.event_count),
          last_event_at: lastEventAt,
          sources: row.sources.split(",")
        });
      }
    }

    return {
      services: [...groupedServices.values()],
      environments: environments.map((row) => ({ ...row, service_count: Number(row.service_count), event_count: Number(row.event_count), last_event_at: isoTimestamp(row.last_event_at) })),
      integrations: integrations.map((row) => ({ ...row, event_count: Number(row.event_count), last_event_at: isoTimestamp(row.last_event_at) }))
    };
  }
}
