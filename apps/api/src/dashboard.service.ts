import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { type IncidentFixture, type NormalizedEvent, validateEvent } from "@incidentiqhq/event-schema";
import { correlate, crossServiceLinks, type CrossServiceLink } from "@incidentiqhq/correlation";
import { DatabaseService } from "./database.js";
import { DashboardSessionService } from "./dashboard-session.service.js";
import { createIncidentReportPdf } from "./incident-report.js";
import { AiExplanationService, type AiExplanation, storedAiExplanation } from "./ai-explanation.service.js";
import { ClickHouseArchiveService, clickHouseConfig, type ArchivedIncidentFilters } from "./clickhouse-archive.service.js";

export interface DashboardIncidentFilters {
  service?: string;
  environment?: string;
  source?: NormalizedEvent["source"];
}

export interface DashboardIncident {
  incident_id: string;
  service: string;
  environment: string;
  state: string;
  started_at: string;
  last_event_at: string;
  event_count: number;
  leading_cause: string;
  confidence: string;
}

export interface DashboardIncidentCursor {
  last_event_at: string;
  incident_id: string;
}

export interface DashboardIncidentPage {
  items: DashboardIncident[];
  next_cursor?: string;
}

export interface DashboardTimelineEvent {
  event_id: string;
  occurred_at: string;
  service: string;
  environment: string;
  source: string;
  event_type: string;
  severity: string;
  version?: string;
  trace_id?: string;
  resource?: string;
  attributes: Record<string, unknown>;
}

export interface DashboardEvidenceFactor {
  name: string;
  description: string;
  score: number;
  evidence_ids: string[];
}

export interface DashboardCauseCandidate {
  cause: string;
  score: number;
}

export interface DashboardInvestigationBrief {
  headline: string;
  summary: string;
  observed_scope: string;
  supporting_evidence: DashboardEvidenceFactor[];
  counterevidence: DashboardEvidenceFactor[];
  candidates: DashboardCauseCandidate[];
}

export interface DashboardIncidentDetail extends DashboardIncident {
  brief: DashboardInvestigationBrief;
  timeline: DashboardTimelineEvent[];
  next_checks: string[];
  ai_available: boolean;
  ai_explanation?: AiExplanation;
  cross_service?: DashboardCrossServiceContext;
  archived?: boolean;
}

export interface DashboardCrossServiceContext {
  related_incident_ids: string[];
  services: Array<{ service: string; event_count: number; role: "primary" | "linked" }>;
  links: CrossServiceLink[];
}

export interface DashboardIncidentReport {
  filename: string;
  content: Buffer;
}

export interface DashboardOverview {
  services: Array<{ service: string; environments: string[]; event_count: number; last_event_at: string; sources: string[] }>;
  environments: Array<{ environment: string; service_count: number; event_count: number; last_event_at: string }>;
  integrations: Array<{ source: string; event_count: number; recent_event_count: number; last_event_at: string }>;
  archive: {
    enabled: boolean;
    tiering_enabled: boolean;
    hot_retention_days?: number;
    queued_records: number;
    retrying_records: number;
    oldest_queued_at?: string;
  };
}

function mostRecent(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

const INCIDENT_PAGE_SIZE = 25;

interface StoredFactor {
  name: string;
  score: number;
  evidence_ids: string[];
}

interface StoredCandidate {
  cause: string;
  score: number;
  factors: StoredFactor[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringAttribute(event: DashboardTimelineEvent | undefined, name: string): string | undefined {
  const value = event?.attributes[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function elapsed(start: string, end: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1_000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function duration(milliseconds: number): string {
  const minutes = milliseconds / 60_000;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function correlationWindow(investigation: unknown): number {
  const value = record(investigation)?.correlation_window_ms;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1_000;
}

function eventFingerprint(events: DashboardTimelineEvent[]): string {
  return createHash("sha256").update(events.map((event) => event.event_id).sort().join("\u0000")).digest("hex");
}

function orderedCrossServiceNames(events: DashboardTimelineEvent[], links: CrossServiceLink[]): string[] {
  const services = new Set(events.map((event) => event.service));
  const incoming = new Map([...services].map((service) => [service, 0]));
  const outgoing = new Map([...services].map((service) => [service, new Set<string>()]));
  for (const link of links) {
    services.add(link.from_service);
    services.add(link.to_service);
    incoming.set(link.from_service, incoming.get(link.from_service) ?? 0);
    incoming.set(link.to_service, incoming.get(link.to_service) ?? 0);
    outgoing.set(link.from_service, outgoing.get(link.from_service) ?? new Set());
    outgoing.set(link.to_service, outgoing.get(link.to_service) ?? new Set());
    if (!outgoing.get(link.from_service)!.has(link.to_service)) {
      outgoing.get(link.from_service)!.add(link.to_service);
      incoming.set(link.to_service, incoming.get(link.to_service)! + 1);
    }
  }
  const pending = [...services].filter((service) => incoming.get(service) === 0).sort();
  const ordered: string[] = [];
  while (pending.length > 0) {
    const service = pending.shift()!;
    ordered.push(service);
    for (const dependent of [...(outgoing.get(service) ?? [])].sort()) {
      incoming.set(dependent, incoming.get(dependent)! - 1);
      if (incoming.get(dependent) === 0) pending.push(dependent);
    }
    pending.sort();
  }
  return [...ordered, ...[...services].filter((service) => !ordered.includes(service)).sort()];
}

@Injectable()
export class DashboardService {
  private readonly explanationsInFlight = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: DashboardSessionService,
    private readonly ai: AiExplanationService,
    private readonly archive: ClickHouseArchiveService
  ) {}

  async overview(cookie: string | undefined): Promise<DashboardOverview> {
    const tenantId = await this.sessions.tenantId(cookie);

    // shortcut: aggregate source_events directly; add tenant rollups when evidence volume outgrows a single operator.
    const [serviceRows, environments, integrations, archiveQueue] = await Promise.all([
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
          sql<number>`count(*) filter (where received_at >= now() - interval '24 hours')`.as("recent_event_count"),
          sql<string>`max(occurred_at)::text`.as("last_event_at")
        ])
        .where("tenant_id", "=", tenantId)
        .groupBy("source")
        .orderBy("source")
        .execute(),
      this.database.db
        .selectFrom("clickhouse_archive_outbox")
        .select(({ fn }) => [
          fn.countAll<string>().as("queued"),
          fn.count<string>("record_id").filterWhere("attempt_count", ">", 0).as("retrying"),
          fn.min<string>("queued_at").as("oldest_queued_at")
        ])
        .where("tenant_id", "=", tenantId)
        .executeTakeFirstOrThrow()
    ]);
    const archiveConfig = clickHouseConfig();

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
      integrations: integrations.map((row) => ({ ...row, event_count: Number(row.event_count), recent_event_count: Number(row.recent_event_count), last_event_at: isoTimestamp(row.last_event_at) })),
      archive: {
        enabled: Boolean(archiveConfig),
        tiering_enabled: Boolean(archiveConfig?.hotRetentionDays),
        ...(archiveConfig?.hotRetentionDays ? { hot_retention_days: archiveConfig.hotRetentionDays } : {}),
        queued_records: Number(archiveQueue.queued),
        retrying_records: Number(archiveQueue.retrying),
        ...(archiveQueue.oldest_queued_at ? { oldest_queued_at: isoTimestamp(archiveQueue.oldest_queued_at) } : {})
      }
    };
  }

  async incidents(
    cookie: string | undefined,
    filters: DashboardIncidentFilters,
    cursor?: DashboardIncidentCursor
  ): Promise<DashboardIncidentPage> {
    const tenantId = await this.sessions.tenantId(cookie);
    let query = this.database.db
      .selectFrom("incidents")
      .select(["incident_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence"])
      .where("tenant_id", "=", tenantId);

    if (filters.service) query = query.where("service", "=", filters.service);
    if (filters.environment) query = query.where("environment", "=", filters.environment);
    const source = filters.source;
    if (source) {
      query = query.where((expression) => expression.exists(
        expression
          .selectFrom("incident_events")
          .innerJoin("source_events", "source_events.event_id", "incident_events.event_id")
          .select(sql`1`.as("matched"))
          .whereRef("incident_events.incident_id", "=", "incidents.incident_id")
          .where("source_events.source", "=", source)
      ));
    }

    if (cursor) {
      query = query.where((expression) => expression.or([
        expression("last_event_at", "<", cursor.last_event_at),
        expression.and([
          expression("last_event_at", "=", cursor.last_event_at),
          expression("incident_id", ">", cursor.incident_id)
        ])
      ]));
    }

    const rows = await query.orderBy("last_event_at", "desc").orderBy("incident_id").limit(INCIDENT_PAGE_SIZE + 1).execute();
    const items = rows.slice(0, INCIDENT_PAGE_SIZE).map((row) => this.summary(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > INCIDENT_PAGE_SIZE && last ? { next_cursor: this.cursor(last) } : {})
    };
  }

  async archivedIncidents(
    cookie: string | undefined,
    filters: ArchivedIncidentFilters,
    cursor?: DashboardIncidentCursor
  ): Promise<DashboardIncidentPage> {
    const tenantId = await this.sessions.tenantId(cookie);
    const rows = await this.archive.archivedIncidents(tenantId, filters, cursor, INCIDENT_PAGE_SIZE + 1);
    const items = rows.slice(0, INCIDENT_PAGE_SIZE).map((row) => this.summary(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > INCIDENT_PAGE_SIZE && last ? { next_cursor: this.cursor(last) } : {})
    };
  }

  async archivedIncident(cookie: string | undefined, incidentId: string): Promise<DashboardIncidentDetail | undefined> {
    const tenantId = await this.sessions.tenantId(cookie);
    const row = await this.archive.archivedIncident(tenantId, incidentId);
    if (!row) return undefined;
    const rawTimeline = record(row.investigation)?.timeline;
    const timeline = Array.isArray(rawTimeline) ? rawTimeline.flatMap((value) => {
      if (!validateEvent(value).valid) return [];
      const { received_at: _receivedAt, tenant_id: _tenantId, ...event } = value as NormalizedEvent;
      return [event];
    }).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at) || left.event_id.localeCompare(right.event_id)) : [];
    const eventIds = new Set(timeline.map((event) => event.event_id));
    const aiExplanation = storedAiExplanation(record(row.investigation)?.ai_explanation, eventIds);
    return {
      ...this.summary(row),
      brief: this.brief(row.leading_cause, row.confidence, row.investigation, timeline),
      timeline,
      next_checks: this.nextChecks(row.investigation),
      ai_available: false,
      archived: true,
      ...(aiExplanation ? { ai_explanation: aiExplanation } : {})
    };
  }

  async incident(cookie: string | undefined, incidentId: string): Promise<DashboardIncidentDetail | undefined> {
    const tenantId = await this.sessions.tenantId(cookie);
    const row = await this.database.db
      .selectFrom("incidents")
      .select(["incident_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence", "investigation"])
      .where("incident_id", "=", incidentId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!row) return undefined;

    const windowMs = correlationWindow(row.investigation);
    const candidateRows = await this.database.db
      .selectFrom("incidents")
      .select(["incident_id", "started_at", "last_event_at"])
      .where("tenant_id", "=", tenantId)
      .where("environment", "=", row.environment)
      .where("incident_id", "!=", incidentId)
      .where("last_event_at", ">=", new Date(Date.parse(row.started_at) - windowMs).toISOString())
      .where("started_at", "<=", new Date(Date.parse(row.last_event_at) + windowMs).toISOString())
      .execute();
    const candidateIds = [incidentId, ...candidateRows.map((candidate) => candidate.incident_id)];
    const eventRows = await this.database.db
      .selectFrom("incident_events")
      .innerJoin("source_events", "source_events.event_id", "incident_events.event_id")
      .select([
        "incident_events.incident_id as source_incident_id",
        "source_events.event_id",
        "source_events.occurred_at",
        "source_events.received_at",
        "source_events.service",
        "source_events.environment",
        "source_events.source",
        "source_events.event_type",
        "source_events.severity",
        "source_events.version",
        "source_events.trace_id",
        "source_events.resource",
        "source_events.attributes"
      ])
      .where("incident_events.incident_id", "in", candidateIds)
      .orderBy("source_events.occurred_at")
      .orderBy("source_events.event_id")
      .execute();
    const byIncident = new Map<string, Array<{ display: DashboardTimelineEvent; normalized: NormalizedEvent }>>();
    const eventIncident = new Map<string, string>();
    for (const event of eventRows) {
      const normalized: NormalizedEvent = {
        event_id: event.event_id,
        occurred_at: isoTimestamp(event.occurred_at),
        received_at: isoTimestamp(event.received_at),
        tenant_id: tenantId,
        environment: row.environment,
        service: event.service,
        source: event.source,
        event_type: event.event_type,
        severity: event.severity,
        ...(event.version === null ? {} : { version: event.version }),
        ...(event.trace_id === null ? {} : { trace_id: event.trace_id }),
        ...(event.resource === null ? {} : { resource: event.resource }),
        attributes: event.attributes as Record<string, unknown>
      };
      const display = (() => {
        const { received_at: _receivedAt, tenant_id: _tenantId, ...value } = normalized;
        return value;
      })();
      byIncident.set(event.source_incident_id, [...(byIncident.get(event.source_incident_id) ?? []), { display, normalized }]);
      eventIncident.set(event.event_id, event.source_incident_id);
    }
    const links = crossServiceLinks([...byIncident.values()].flatMap((events) => events.map((event) => event.normalized)), windowMs);
    const linkedIncidents = new Map<string, Set<string>>([[incidentId, new Set()]]);
    for (const link of links) {
      const ids = [...new Set(link.evidence_ids.flatMap((eventId) => {
        const sourceIncidentId = eventIncident.get(eventId);
        return sourceIncidentId ? [sourceIncidentId] : [];
      }))];
      for (const left of ids) for (const right of ids) if (left !== right) {
        linkedIncidents.set(left, linkedIncidents.get(left) ?? new Set());
        linkedIncidents.get(left)!.add(right);
      }
    }
    const selectedIncidentIds = new Set<string>([incidentId]);
    const pending = [incidentId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const related of linkedIncidents.get(current) ?? []) if (!selectedIncidentIds.has(related)) {
        selectedIncidentIds.add(related);
        pending.push(related);
      }
    }
    const selectedEvents = [...selectedIncidentIds].flatMap((id) => byIncident.get(id) ?? []);
    const timeline = selectedEvents.map((event) => event.display).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at) || left.event_id.localeCompare(right.event_id));
    const isCrossService = selectedIncidentIds.size > 1;
    const crossInvestigation = isCrossService
      ? correlate({ fixture_id: incidentId, scenario: `Cross-service evidence correlated for ${row.environment}`, expected_cause: "automatic_cross_service", events: selectedEvents.map((event) => event.normalized) } satisfies IncidentFixture, { eventWindowMs: windowMs })
      : undefined;
    const investigation = crossInvestigation ?? row.investigation;
    const eventIds = new Set(timeline.map((event) => event.event_id));
    const storedExplanation = record(row.investigation)?.ai_explanation;
    const aiExplanation = !isCrossService || record(storedExplanation)?.evidence_fingerprint === eventFingerprint(timeline)
      ? storedAiExplanation(storedExplanation, eventIds)
      : undefined;
    const firstEvent = timeline[0];
    const lastEvent = timeline.at(-1);
    const summary = this.summary(row);
    const crossLinks = links.filter((link) => link.evidence_ids.every((eventId) => {
      const sourceIncidentId = eventIncident.get(eventId);
      return sourceIncidentId !== undefined && selectedIncidentIds.has(sourceIncidentId);
    }));

    return {
      ...summary,
      ...(isCrossService ? {
        started_at: firstEvent?.occurred_at ?? summary.started_at,
        last_event_at: lastEvent?.occurred_at ?? summary.last_event_at,
        event_count: timeline.length,
        leading_cause: crossInvestigation!.leading_cause,
        confidence: crossInvestigation!.confidence
      } : {}),
      brief: this.brief(crossInvestigation?.leading_cause ?? row.leading_cause, crossInvestigation?.confidence ?? row.confidence, investigation, timeline),
      timeline,
      next_checks: this.nextChecks(investigation),
      ai_available: this.ai.available(),
      ...(isCrossService ? {
        cross_service: {
          related_incident_ids: [...selectedIncidentIds].filter((id) => id !== incidentId).sort(),
          services: orderedCrossServiceNames(timeline, crossLinks).map((service) => ({ service, event_count: timeline.filter((event) => event.service === service).length, role: service === row.service ? "primary" : "linked" })),
          links: crossLinks
        }
      } : {}),
      ...(aiExplanation ? { ai_explanation: aiExplanation } : {})
    };
  }

  async explainIncident(cookie: string | undefined, incidentId: string): Promise<AiExplanation | undefined> {
    const tenantId = await this.sessions.tenantId(cookie);
    const row = await this.database.db
      .selectFrom("incidents")
      .select(["investigation", sql<string>`xmin::text`.as("row_version")])
      .where("incident_id", "=", incidentId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!row) return undefined;

    const incident = await this.incident(cookie, incidentId);
    if (!incident) return undefined;
    if (incident.ai_explanation) return incident.ai_explanation;

    const requestId = `${tenantId}:${incidentId}`;
    if (this.explanationsInFlight.has(requestId)) throw new ConflictException("An AI explanation is already being generated for this incident");
    this.explanationsInFlight.add(requestId);
    try {
      const explanation = await this.ai.generate(incident, tenantId);
      const investigation = record(row.investigation) ?? {};
      const updated = await this.database.db
        .updateTable("incidents")
        .set({ investigation: { ...investigation, ai_explanation: { ...explanation, evidence_fingerprint: eventFingerprint(incident.timeline) } }, updated_at: explanation.generated_at })
        .where("incident_id", "=", incidentId)
        .where("tenant_id", "=", tenantId)
        .where(sql<boolean>`xmin::text = ${row.row_version}`)
        .returning("incident_id")
        .executeTakeFirst();
      if (!updated) throw new ConflictException("The incident changed while the explanation was generated; try again");
      return explanation;
    } finally {
      this.explanationsInFlight.delete(requestId);
    }
  }

  async incidentReport(cookie: string | undefined, incidentId: string): Promise<DashboardIncidentReport | undefined> {
    const incident = await this.incident(cookie, incidentId);
    if (!incident) return undefined;
    const safeName = `${incident.service}-${incident.incident_id}`.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
    return { filename: `incidentiq-${safeName}.pdf`, content: await createIncidentReportPdf(incident) };
  }

  private summary(row: {
    incident_id: string;
    service: string;
    environment: string;
    state: string;
    started_at: string;
    last_event_at: string;
    event_count: number;
    leading_cause: string;
    confidence: string;
  }): DashboardIncident {
    return { ...row, event_count: Number(row.event_count), started_at: isoTimestamp(row.started_at), last_event_at: isoTimestamp(row.last_event_at) };
  }

  private nextChecks(investigation: unknown): string[] {
    if (!investigation || typeof investigation !== "object") return [];
    const checks = (investigation as { next_checks?: unknown }).next_checks;
    return Array.isArray(checks) && checks.every((check) => typeof check === "string") ? checks : [];
  }

  private brief(
    leadingCause: string,
    confidence: string,
    investigation: unknown,
    timeline: DashboardTimelineEvent[]
  ): DashboardInvestigationBrief {
    const candidates = this.candidates(investigation, timeline);
    const storedInvestigation = record(investigation);
    const correlationWindowMs = typeof storedInvestigation?.correlation_window_ms === "number" ? storedInvestigation.correlation_window_ms : undefined;
    const leading = candidates.find((candidate) => candidate.cause === leadingCause) ?? candidates[0];
    const factors = leading?.factors.map((factor) => ({ ...factor, description: this.factorDescription(factor, timeline, correlationWindowMs) })) ?? [];
    const sources = new Set(timeline.map((event) => event.source));
    const impactSignals = timeline.filter((event) => event.severity === "error" || event.severity === "critical");
    const first = timeline[0];
    const last = timeline.at(-1);
    const window = first && last ? elapsed(first.occurred_at, last.occurred_at) : "an unknown duration";

    return {
      headline: this.causeHeadline(leadingCause),
      summary: this.causeSummary(leadingCause, confidence, timeline, leading?.factors ?? []),
      observed_scope: `${timeline.length} linked events from ${sources.size} evidence source${sources.size === 1 ? "" : "s"} span ${window}. ${impactSignals.length} error or critical signal${impactSignals.length === 1 ? " was" : "s were"} recorded; this is observed evidence, not a measurement of customer impact.`,
      supporting_evidence: factors.filter((factor) => factor.score > 0),
      counterevidence: factors.filter((factor) => factor.score < 0),
      candidates: candidates.map(({ cause, score }) => ({ cause, score }))
    };
  }

  private candidates(investigation: unknown, timeline: DashboardTimelineEvent[]): StoredCandidate[] {
    const rawCandidates = record(investigation)?.candidates;
    if (!Array.isArray(rawCandidates)) return [];
    return rawCandidates.flatMap((value) => {
      const candidate = record(value);
      if (!candidate || typeof candidate.cause !== "string" || typeof candidate.score !== "number" || !Array.isArray(candidate.factors)) return [];
      const factors = candidate.factors.flatMap((factorValue) => {
        const factor = record(factorValue);
        if (!factor || typeof factor.name !== "string" || typeof factor.score !== "number" || !Array.isArray(factor.evidence_ids) || !factor.evidence_ids.every((id) => typeof id === "string")) return [];
        return [{ name: factor.name, score: factor.score, evidence_ids: factor.evidence_ids as string[] }];
      });
      const grouped = new Map<string, StoredFactor & { occurrences: number }>();
      for (const factor of factors) {
        const factorServices = new Set(factor.evidence_ids.flatMap((eventId) => {
          const event = timeline.find((candidateEvent) => candidateEvent.event_id === eventId);
          return event ? [event.service] : [];
        }));
        const name = candidate.cause === "downstream_timeout" && factor.name === "entity_match" && factorServices.size > 1 ? "trace_link" : factor.name;
        const current = grouped.get(name);
        if (!current) {
          grouped.set(name, { ...factor, name, evidence_ids: [...new Set(factor.evidence_ids)], occurrences: 1 });
          continue;
        }
        if (current.occurrences < 3) current.score += factor.score;
        current.occurrences += 1;
        current.evidence_ids = [...new Set([...current.evidence_ids, ...factor.evidence_ids])];
      }
      const aggregated = [...grouped.values()].map(({ occurrences: _occurrences, ...factor }) => factor);
      return [{ cause: candidate.cause, score: aggregated.reduce((total, factor) => total + factor.score, 0), factors: aggregated }];
    }).sort((left, right) => right.score - left.score || left.cause.localeCompare(right.cause));
  }

  private causeHeadline(cause: string): string {
    switch (cause) {
      case "bad_release": return "The release is linked to a route-specific failure";
      case "deployment_regression": return "A recent deployment is the strongest explanation";
      case "resource_exhaustion": return "Workload resource failure is the strongest explanation";
      case "downstream_timeout": return "A downstream dependency likely failed first";
      default: return "The evidence does not yet isolate one cause";
    }
  }

  private causeSummary(cause: string, confidence: string, timeline: DashboardTimelineEvent[], factors: StoredFactor[]): string {
    const deployment = timeline.find((event) => event.event_type === "deployment");
    const error = timeline.find((event) => event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical"));
    const resource = timeline.find((event) => event.event_type === "oom_killed" || event.event_type === "crash_loop_back_off");
    const version = error?.version ?? deployment?.version ?? "the deployed version";
    const route = stringAttribute(error, "route") ?? "an application request";

    if ((cause === "bad_release" || cause === "deployment_regression") && deployment && error) {
      return `${version} was deployed, then ${route} reported its first linked application error ${elapsed(deployment.occurred_at, error.occurred_at)} later. Matching service${deployment.version && deployment.version === error.version ? " and version" : ""} evidence makes this a ${confidence}-confidence hypothesis, not proof.`;
    }
    if (cause === "resource_exhaustion" && resource) {
      return `${resource.resource ?? "The affected workload"} reported ${resource.event_type.replaceAll("_", " ")}. Application and workload evidence in the same window make resource exhaustion the strongest hypothesis, but resource metrics should confirm it.`;
    }
    if (cause === "downstream_timeout") {
      const propagation = factors.find((factor) => factor.name === "propagation_order");
      const evidence = propagation?.evidence_ids.flatMap((eventId) => {
        const event = timeline.find((candidate) => candidate.event_id === eventId);
        return event ? [event] : [];
      }) ?? [];
      const [downstream, upstream] = evidence;
      const traces = new Set(evidence.flatMap((event) => event.trace_id ? [event.trace_id] : []));
      if (downstream && upstream) {
        const count = traces.size || 1;
        return `${count} correlated trace${count === 1 ? "" : "s"} show ${downstream.service} failures preceding ${upstream.service} failures. The repeated ordering makes downstream propagation the leading ${confidence}-confidence hypothesis; it does not identify the initiating code, configuration, or infrastructure fault.`;
      }
      return `Correlated application failures make downstream propagation the leading ${confidence}-confidence hypothesis, but the initiating fault has not been identified.`;
    }
    return "The current candidates are too close or too weak to identify one likely cause. Collect the missing baseline, trace, or resource evidence before choosing a remediation.";
  }

  private factorDescription(factor: StoredFactor, timeline: DashboardTimelineEvent[], correlationWindowMs?: number): string {
    const evidence = factor.evidence_ids.flatMap((eventId) => {
      const event = timeline.find((candidate) => candidate.event_id === eventId);
      return event ? [event] : [];
    });
    const [first, second] = evidence;
    const service = first?.service ?? second?.service;
    const environment = first?.environment ?? second?.environment;

    switch (factor.name) {
      case "temporal_proximity": {
        if (!first || !second) return `The linked signals occurred inside the configured correlation window${correlationWindowMs ? ` (${duration(correlationWindowMs)})` : ""}.`;
        const [earlier, later] = Date.parse(first.occurred_at) <= Date.parse(second.occurred_at) ? [first, second] : [second, first];
        return `The ${this.eventDescription(earlier)} was followed ${elapsed(earlier.occurred_at, later.occurred_at)} later by ${this.eventDescription(later)}. That sequence fits the configured evidence window${correlationWindowMs ? ` of ${duration(correlationWindowMs)}` : ""}; timing supports the hypothesis but does not prove causation.`;
      }
      case "entity_match": {
        if (!service) return "The linked evidence points to the same affected service.";
        return `Every linked signal names ${service}${environment ? ` in ${environment}` : ""}. This shows the deployment and failure belong to the same workload rather than unrelated services, although identity alone does not establish cause.`;
      }
      case "trace_link": {
        const traces = new Set(evidence.flatMap((event) => event.trace_id ? [event.trace_id] : []));
        const services = [...new Set(evidence.map((event) => event.service))];
        const traceCount = traces.size || Math.ceil(evidence.length / 2);
        return `${traceCount} shared trace${traceCount === 1 ? "" : "s"} link ${services.join(" and ") || "the affected services"}${environment ? ` in ${environment}` : ""}. This establishes a cross-service propagation path, but does not by itself prove where the failure originated.`;
      }
      case "version_match": {
        const version = first?.version && first.version === second?.version ? first.version : first?.version ?? second?.version;
        return version
          ? `Both the release evidence and the application failure report version ${version}. This ties the failing request to the released artifact instead of relying only on similar timing.`
          : "The release and application failure report the same version, tying the failing request to the released artifact.";
      }
      case "propagation_order": {
        if (!first || !second) return "The dependency failure appeared before the upstream failure on the same trace.";
        const traces = new Set(evidence.flatMap((event) => event.trace_id ? [event.trace_id] : []));
        if (traces.size > 1) {
          return `Across ${traces.size} shared traces, ${first.service} failures appeared before ${second.service} failures. The repeated order supports downstream-to-upstream propagation instead of a single coincidental timeout.`;
        }
        const trace = first.trace_id ?? second.trace_id;
        return `The ${this.eventDescription(first)} appeared before ${this.eventDescription(second)}${trace ? ` on trace ${trace}` : ""}. That order is consistent with a downstream failure propagating to the affected service.`;
      }
      case "resource_signal": {
        if (!first) return "Kubernetes reported a direct workload resource failure.";
        const reason = stringAttribute(first, "reason") ?? stringAttribute(first, "message");
        return `Kubernetes recorded ${first.event_type.replaceAll("_", " ")} for ${first.resource ?? first.service}${reason ? `: ${reason}` : ""}. This is direct workload-failure evidence; CPU and memory metrics should confirm whether resource pressure caused it.`;
      }
      case "route_specificity": {
        const route = stringAttribute(first, "route") ?? first?.resource?.replace(/^route\//, "");
        const status = first?.attributes.status_code;
        const message = stringAttribute(first, "message");
        return `${route ? `The first linked application failure identifies ${route}` : "The application error identifies a specific failing route"}${typeof status === "number" ? ` returning HTTP ${status}` : ""}${message ? ` with "${message}"` : ""}. This gives a concrete request to reproduce on the suspected version and compare with the previous release.`;
      }
      case "counterevidence": {
        if (!first || !second) return "A similar failure existed before the suspected change, weakening this hypothesis.";
        return `A ${this.eventDescription(first)} was already present before ${this.eventDescription(second)}. A pre-existing failure can explain the symptom without the suspected change, so this evidence lowers confidence.`;
      }
      default: return factor.name.replaceAll("_", " ");
    }
  }

  private eventDescription(event: DashboardTimelineEvent): string {
    if (event.event_type === "deployment") return `deployment of version ${event.version ?? "unknown"}`;
    if (event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical")) {
      const route = stringAttribute(event, "route") ?? event.resource?.replace(/^route\//, "");
      return `${event.event_type.replaceAll("_", " ")}${route ? ` on ${route}` : ` in ${event.service}`}`;
    }
    if (event.source === "kubernetes") return `Kubernetes ${event.event_type.replaceAll("_", " ")} for ${event.resource ?? event.service}`;
    if (event.source === "alertmanager") return `${stringAttribute(event, "alertname") ?? event.event_type.replaceAll("_", " ")} alert`;
    return `${event.source.replaceAll("_", " ")} ${event.event_type.replaceAll("_", " ")}`;
  }

  private cursor(incident: DashboardIncident): string {
    return Buffer.from(JSON.stringify({ last_event_at: incident.last_event_at, incident_id: incident.incident_id })).toString("base64url");
  }
}
