import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { NormalizedEvent } from "@incidentiqhq/event-schema";
import { DatabaseService } from "./database.js";
import { DashboardSessionService } from "./dashboard-session.service.js";
import { createIncidentReportPdf } from "./incident-report.js";

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
  context?: string;
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
}

export interface DashboardIncidentReport {
  filename: string;
  content: Buffer;
}

export interface DashboardOverview {
  services: Array<{ service: string; environments: string[]; event_count: number; last_event_at: string; sources: string[] }>;
  environments: Array<{ environment: string; service_count: number; event_count: number; last_event_at: string }>;
  integrations: Array<{ source: string; event_count: number; recent_event_count: number; last_event_at: string }>;
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
          sql<number>`count(*) filter (where received_at >= now() - interval '24 hours')`.as("recent_event_count"),
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
      integrations: integrations.map((row) => ({ ...row, event_count: Number(row.event_count), recent_event_count: Number(row.recent_event_count), last_event_at: isoTimestamp(row.last_event_at) }))
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

  async incident(cookie: string | undefined, incidentId: string): Promise<DashboardIncidentDetail | undefined> {
    const tenantId = await this.sessions.tenantId(cookie);
    const row = await this.database.db
      .selectFrom("incidents")
      .select(["incident_id", "service", "environment", "state", "started_at", "last_event_at", "event_count", "leading_cause", "confidence", "investigation"])
      .where("incident_id", "=", incidentId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!row) return undefined;

    const timelineRows = await this.database.db
      .selectFrom("incident_events")
      .innerJoin("source_events", "source_events.event_id", "incident_events.event_id")
      .select([
        "source_events.event_id",
        "source_events.occurred_at",
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
      .where("incident_events.incident_id", "=", incidentId)
      .orderBy("source_events.occurred_at")
      .orderBy("source_events.event_id")
      .execute();

    const timeline = timelineRows.map(({ version, trace_id, resource, attributes, occurred_at, ...event }) => ({
      ...event,
      occurred_at: isoTimestamp(occurred_at),
      ...(version === null ? {} : { version }),
      ...(trace_id === null ? {} : { trace_id }),
      ...(resource === null ? {} : { resource }),
      attributes: attributes as Record<string, unknown>
    }));

    return {
      ...this.summary(row),
      brief: this.brief(row.leading_cause, row.confidence, row.investigation, timeline),
      timeline,
      next_checks: this.nextChecks(row.investigation)
    };
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
    const candidates = this.candidates(investigation);
    const storedInvestigation = record(investigation);
    const scenario = storedInvestigation?.scenario;
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
      ...(typeof scenario === "string" && scenario.trim() ? { context: scenario } : {}),
      summary: this.causeSummary(leadingCause, confidence, timeline),
      observed_scope: `${timeline.length} linked events from ${sources.size} evidence source${sources.size === 1 ? "" : "s"} span ${window}. ${impactSignals.length} error or critical signal${impactSignals.length === 1 ? " was" : "s were"} recorded; this is observed evidence, not a measurement of customer impact.`,
      supporting_evidence: factors.filter((factor) => factor.score > 0),
      counterevidence: factors.filter((factor) => factor.score < 0),
      candidates: candidates.map(({ cause, score }) => ({ cause, score }))
    };
  }

  private candidates(investigation: unknown): StoredCandidate[] {
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
      return [{ cause: candidate.cause, score: candidate.score, factors }];
    });
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

  private causeSummary(cause: string, confidence: string, timeline: DashboardTimelineEvent[]): string {
    const deployment = timeline.find((event) => event.event_type === "deployment");
    const error = timeline.find((event) => event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical"));
    const resource = timeline.find((event) => event.event_type === "oom_killed" || event.event_type === "crash_loop_back_off");
    const dependencyError = timeline.find((event) => stringAttribute(event, "dependency"));
    const version = error?.version ?? deployment?.version ?? "the deployed version";
    const route = stringAttribute(error, "route") ?? "an application request";

    if ((cause === "bad_release" || cause === "deployment_regression") && deployment && error) {
      return `${version} was deployed, then ${route} reported its first linked application error ${elapsed(deployment.occurred_at, error.occurred_at)} later. Matching service${deployment.version && deployment.version === error.version ? " and version" : ""} evidence makes this a ${confidence}-confidence hypothesis, not proof.`;
    }
    if (cause === "resource_exhaustion" && resource) {
      return `${resource.resource ?? "The affected workload"} reported ${resource.event_type.replaceAll("_", " ")}. Application and workload evidence in the same window make resource exhaustion the strongest hypothesis, but resource metrics should confirm it.`;
    }
    if (cause === "downstream_timeout" && dependencyError) {
      return `A failure in ${stringAttribute(dependencyError, "dependency") ?? "a downstream dependency"} appeared before the affected service on the same trace. The ordering supports propagation from the dependency, but its own health data should confirm the origin.`;
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
      case "version_match": {
        const version = first?.version && first.version === second?.version ? first.version : first?.version ?? second?.version;
        return version
          ? `Both the release evidence and the application failure report version ${version}. This ties the failing request to the released artifact instead of relying only on similar timing.`
          : "The release and application failure report the same version, tying the failing request to the released artifact.";
      }
      case "propagation_order": {
        if (!first || !second) return "The dependency failure appeared before the upstream failure on the same trace.";
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
