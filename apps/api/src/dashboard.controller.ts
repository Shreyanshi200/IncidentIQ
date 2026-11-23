import { BadRequestException, Controller, Delete, Get, Headers, Ip, NotFoundException, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import { DashboardSessionService } from "./dashboard-session.service.js";
import { type DashboardIncidentCursor, type DashboardIncidentDetail, type DashboardIncidentFilters, type DashboardIncidentPage, type DashboardOverview, DashboardService } from "./dashboard.service.js";
import type { AiExplanation } from "./ai-explanation.service.js";
import type { ArchivedIncidentFilters } from "./clickhouse-archive.service.js";

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

function usesHttps(forwardedProtocol: string | undefined): boolean {
  return forwardedProtocol?.split(",")[0]?.trim() === "https";
}

function filter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SOURCES = new Set<DashboardIncidentFilters["source"]>(["node_sdk", "github_actions", "kubernetes", "alertmanager", "internal"]);

function sourceFilter(value: unknown): DashboardIncidentFilters["source"] {
  const source = filter(value);
  return source && SOURCES.has(source as DashboardIncidentFilters["source"]) ? source as DashboardIncidentFilters["source"] : undefined;
}

function incidentCursor(value: unknown): DashboardIncidentCursor | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException("Invalid incident cursor");

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DashboardIncidentCursor>;
    if (
      typeof parsed.last_event_at !== "string" ||
      Number.isNaN(Date.parse(parsed.last_event_at)) ||
      typeof parsed.incident_id !== "string" ||
      !parsed.incident_id
    ) {
      throw new Error("Invalid cursor fields");
    }
    return { last_event_at: parsed.last_event_at, incident_id: parsed.incident_id };
  } catch {
    throw new BadRequestException("Invalid incident cursor");
  }
}

function timestampFilter(value: unknown, name: string): string | undefined {
  const timestamp = filter(value);
  if (!timestamp) return undefined;
  if (Number.isNaN(Date.parse(timestamp))) throw new BadRequestException(`${name} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

@Controller("v1/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService, private readonly sessions: DashboardSessionService) {}

  @Post("session")
  async createSession(
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-forwarded-proto") forwardedProtocol: string | undefined,
    @Ip() clientIp: string,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<{ expires_at: string }> {
    const session = await this.sessions.create(authorization, clientIp);
    response.setHeader("set-cookie", this.sessions.cookie(session.token, usesHttps(forwardedProtocol)));
    return { expires_at: session.expires_at };
  }

  @Delete("session")
  clearSession(
    @Headers("x-forwarded-proto") forwardedProtocol: string | undefined,
    @Res({ passthrough: true }) response: HeaderResponse
  ): { cleared: true } {
    response.setHeader("set-cookie", this.sessions.clearCookie(usesHttps(forwardedProtocol)));
    return { cleared: true };
  }

  @Get("overview")
  overview(@Headers("cookie") cookie: string | undefined): Promise<DashboardOverview> {
    return this.dashboard.overview(cookie);
  }

  @Get("incidents")
  incidents(
    @Headers("cookie") cookie: string | undefined,
    @Query("service") service: unknown,
    @Query("environment") environment: unknown,
    @Query("source") source: unknown,
    @Query("cursor") cursor: unknown
  ): Promise<DashboardIncidentPage> {
    return this.dashboard.incidents(
      cookie,
      { service: filter(service), environment: filter(environment), source: sourceFilter(source) } satisfies DashboardIncidentFilters,
      incidentCursor(cursor)
    );
  }

  @Get("incidents/:incidentId")
  async incident(@Headers("cookie") cookie: string | undefined, @Param("incidentId") incidentId: string): Promise<DashboardIncidentDetail> {
    const incident = await this.dashboard.incident(cookie, incidentId);
    if (!incident) throw new NotFoundException("Incident not found");
    return incident;
  }

  @Get("archive/incidents")
  archivedIncidents(
    @Headers("cookie") cookie: string | undefined,
    @Query("service") service: unknown,
    @Query("environment") environment: unknown,
    @Query("cause") cause: unknown,
    @Query("from") from: unknown,
    @Query("to") to: unknown,
    @Query("cursor") cursor: unknown
  ): Promise<DashboardIncidentPage> {
    return this.dashboard.archivedIncidents(cookie, {
      service: filter(service),
      environment: filter(environment),
      cause: filter(cause),
      from: timestampFilter(from, "from"),
      to: timestampFilter(to, "to")
    } satisfies ArchivedIncidentFilters, incidentCursor(cursor));
  }

  @Get("archive/incidents/:incidentId")
  async archivedIncident(@Headers("cookie") cookie: string | undefined, @Param("incidentId") incidentId: string): Promise<DashboardIncidentDetail> {
    const incident = await this.dashboard.archivedIncident(cookie, incidentId);
    if (!incident) throw new NotFoundException("Archived incident not found");
    return incident;
  }

  @Post("incidents/:incidentId/ai-explanation")
  async explainIncident(@Headers("cookie") cookie: string | undefined, @Param("incidentId") incidentId: string): Promise<AiExplanation> {
    const explanation = await this.dashboard.explainIncident(cookie, incidentId);
    if (!explanation) throw new NotFoundException("Incident not found");
    return explanation;
  }

  @Get("incidents/:incidentId/report")
  async incidentReport(
    @Headers("cookie") cookie: string | undefined,
    @Param("incidentId") incidentId: string
  ): Promise<StreamableFile> {
    const report = await this.dashboard.incidentReport(cookie, incidentId);
    if (!report) throw new NotFoundException("Incident not found");
    return new StreamableFile(report.content, {
      type: "application/pdf",
      disposition: `attachment; filename="${report.filename}"`
    });
  }
}
