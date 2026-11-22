import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface DashboardOverview {
  services: Array<{ service: string; environments: string[]; event_count: number; last_event_at: string; sources: string[] }>;
  environments: Array<{ environment: string; service_count: number; event_count: number; last_event_at: string }>;
  integrations: Array<{ source: string; event_count: number; recent_event_count: number; last_event_at: string }>;
}

interface DashboardIncident {
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

interface DashboardIncidentPage {
  items: DashboardIncident[];
  next_cursor?: string;
}

interface DashboardIncidentDetail extends DashboardIncident {
  brief: {
    headline: string;
    summary: string;
    observed_scope: string;
    supporting_evidence: Array<{ name: string; description: string; score: number; evidence_ids: string[] }>;
    counterevidence: Array<{ name: string; description: string; score: number; evidence_ids: string[] }>;
    candidates: Array<{ cause: string; score: number }>;
  };
  timeline: Array<{
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
  }>;
  next_checks: string[];
  ai_available: boolean;
  ai_explanation?: AiExplanation;
  cross_service?: {
    related_incident_ids: string[];
    services: Array<{ service: string; event_count: number; role: "primary" | "linked" }>;
    links: Array<{ from_service: string; to_service: string; reason: "shared_trace" | "declared_dependency"; evidence_ids: string[]; trace_id?: string }>;
  };
}

interface GroupedCrossServiceLink {
  from_service: string;
  to_service: string;
  evidence_ids: string[];
  trace_count: number;
  dependency_count: number;
}

interface AiExplanation {
  summary: string;
  likely_cause: string;
  confidence_basis: string;
  evidence: Array<{ claim: string; evidence_ids: string[] }>;
  next_checks: Array<{ action: string; reason: string; evidence_ids: string[] }>;
  limitations: string[];
  generated_at: string;
  model: string;
}

interface IncidentFilters {
  service: string;
  environment: string;
  source: string;
}

type DashboardView = "overview" | "investigations" | "detail";
type IncidentTab = "analysis" | "evidence" | "ai";

const apiBaseUrl = (import.meta.env.VITE_INCIDENTIQ_API_URL ?? "").replace(/\/$/, "");
const emptyFilters: IncidentFilters = { service: "", environment: "", source: "" };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1_440)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function newestFirst<T extends { last_event_at: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => Date.parse(right.last_event_at) - Date.parse(left.last_event_at));
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function traceLabel(value: string): string {
  return value.toLowerCase().startsWith("trace-") ? value : `trace ${value}`;
}

function factorLabel(value: string): string {
  switch (value) {
    case "temporal_proximity": return "Failure followed the suspected change";
    case "entity_match": return "Same service and environment";
    case "version_match": return "Same deployed version";
    case "propagation_order": return "Dependency failed first";
    case "trace_link": return "Shared traces link both services";
    case "resource_signal": return "Direct workload failure";
    case "route_specificity": return "A specific request path failed";
    case "counterevidence": return "Failure existed before the change";
    default: return humanize(value);
  }
}

function factorHighlight(description: string): string {
  return description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
}

function sourceLabel(value: string): string {
  return value === "internal" ? "IncidentIQ system events" : humanize(value);
}

const HIGHLIGHTED_ATTRIBUTES = new Set(["route", "path", "endpoint", "dependency", "commit_sha", "commit", "namespace"]);

function evidenceTerms(incident: DashboardIncidentDetail): string[] {
  const terms = new Set<string>();
  for (const event of incident.timeline) {
    for (const value of [event.service, event.version, event.trace_id, event.resource]) if (value && value.length <= 120) terms.add(value);
    for (const [name, value] of Object.entries(event.attributes)) {
      if (!HIGHLIGHTED_ATTRIBUTES.has(name) || typeof value !== "string" || value.length < 2 || value.length > 120) continue;
      terms.add(value);
      if ((name === "commit" || name === "commit_sha") && value.length > 12) terms.add(value.slice(0, 12));
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 80);
}

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const highlighted = new Set(terms);
  return text.split(new RegExp(`(${escaped.join("|")})`, "g")).map((part, index) => highlighted.has(part) ? <mark className="evidence-token" key={`${part}-${index}`}>{part}</mark> : part);
}

function RelativeAge({ value }: { value: string }) {
  const age = formatAge(value);
  if (!age.endsWith(" ago")) return age;
  return <>{age.slice(0, -4)} <span className="ago-suffix">ago</span></>;
}

function DotLegend({ kind }: { kind: "evidence" | "activity" }) {
  return <span className="dot-legend">
    <button type="button" className="legend-trigger" aria-label={`${kind} colour legend`}>?</button>
    <span className="legend-popover" role="tooltip">
      {kind === "evidence" ? <>
        <span><i className="legend-dot info" />Information or recovery</span>
        <span><i className="legend-dot warning" />Warning or degradation</span>
        <span><i className="legend-dot error" />Error or critical failure</span>
      </> : <>
        <span><i className="legend-dot active" />Evidence received in the last 24h</span>
        <span><i className="legend-dot quiet" />No evidence received in the last 24h</span>
      </>}
    </span>
  </span>;
}

function attribute(event: DashboardIncidentDetail["timeline"][number], ...names: string[]): string | undefined {
  for (const name of names) {
    const value = event.attributes[name];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function describeEvent(event: DashboardIncidentDetail["timeline"][number]): string {
  if (event.event_type === "deployment") {
    const state = attribute(event, "deployment_status", "state") ?? "recorded";
    const ref = attribute(event, "ref");
    const commit = attribute(event, "commit_sha", "commit");
    return `Deployment ${state}${event.version ? ` for version ${event.version}` : ""}${ref ? ` from ${ref}` : ""}${commit ? ` at commit ${commit.slice(0, 12)}` : ""}.`;
  }
  if (event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical")) {
    const message = attribute(event, "message", "error_type") ?? "Application exception";
    const route = attribute(event, "route");
    const dependency = attribute(event, "dependency");
    return `${message}${route ? ` on ${route}` : ""}${dependency ? ` while calling ${dependency}` : ""}.`;
  }
  if (event.source === "kubernetes") {
    const ready = attribute(event, "ready_replicas");
    const desired = attribute(event, "desired_replicas");
    if (event.event_type === "deployment_recovered") {
      return `${event.resource ?? event.service} recovered${event.version ? ` on version ${event.version}` : ""}${ready && desired ? ` with ${ready} of ${desired} replicas ready` : ""}.`;
    }
    const restarts = attribute(event, "restarts", "restart_count");
    const reason = attribute(event, "reason", "message");
    return `${event.resource ?? "The workload"} reported ${humanize(event.event_type)}${restarts ? ` after ${restarts} restart${restarts === "1" ? "" : "s"}` : ""}${reason ? `: ${reason}` : "."}`;
  }
  if (event.source === "alertmanager") {
    const alert = attribute(event, "alertname", "alert_name") ?? humanize(event.event_type);
    const state = attribute(event, "status", "state") ?? event.severity;
    const value = attribute(event, "value", "current_value");
    const threshold = attribute(event, "threshold");
    return `${alert} was ${state}${value ? ` at ${value}` : ""}${threshold ? ` against threshold ${threshold}` : ""}.`;
  }
  if (event.event_type === "health_check" || event.event_type === "service_state") {
    const state = attribute(event, "status") ?? humanize(event.event_type);
    const ready = attribute(event, "ready_replicas");
    const desired = attribute(event, "desired_replicas");
    const alerts = attribute(event, "open_alerts");
    return `${event.service} reported ${state}${ready && desired ? ` with ${ready} of ${desired} replicas ready` : ""}${alerts ? ` and ${alerts} open alerts` : ""}.`;
  }
  return `${sourceLabel(event.source)} recorded ${humanize(event.event_type)} for ${event.service}.`;
}

function scrollToEvidence(eventId: string): void {
  document.getElementById(`evidence-${eventId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function incidentUrl(filters: IncidentFilters, cursor?: string): string {
  const search = new URLSearchParams();
  if (filters.service) search.set("service", filters.service);
  if (filters.environment) search.set("environment", filters.environment);
  if (filters.source) search.set("source", filters.source);
  if (cursor) search.set("cursor", cursor);
  const query = search.toString();
  return `/v1/dashboard/incidents${query ? `?${query}` : ""}`;
}

function incidentRouteFromHash(): { incidentId: string; tab: IncidentTab } | undefined {
  const match = window.location.hash.match(/^#incidents\/([^/]+)(?:\/(analysis|evidence|ai-review))?$/);
  if (!match?.[1]) return undefined;
  try {
    const tab = match[2] === "evidence" ? "evidence" : match[2] === "ai-review" ? "ai" : "analysis";
    return { incidentId: decodeURIComponent(match[1]), tab };
  } catch {
    return undefined;
  }
}

function incidentIdFromHash(): string | undefined {
  return incidentRouteFromHash()?.incidentId;
}

function incidentTabPath(tab: IncidentTab): string {
  return tab === "ai" ? "ai-review" : tab;
}

function initialView(): DashboardView {
  return incidentIdFromHash() ? "detail" : window.location.hash === "#investigations" ? "investigations" : "overview";
}

function App() {
  const [key, setKey] = useState("");
  const [overview, setOverview] = useState<DashboardOverview>();
  const [incidents, setIncidents] = useState<DashboardIncident[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [filters, setFilters] = useState<IncidentFilters>(emptyFilters);
  const [selectedIncident, setSelectedIncident] = useState<DashboardIncidentDetail>();
  const [view, setView] = useState<DashboardView>(initialView);
  const [detailTab, setDetailTab] = useState<IncidentTab>(() => incidentRouteFromHash()?.tab ?? "analysis");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date>();

  function navigate(nextView: DashboardView, incidentId?: string, tab: IncidentTab = "analysis"): void {
    setView(nextView);
    if (nextView === "detail") setDetailTab(tab);
    const hash = nextView === "detail" && incidentId ? `#incidents/${encodeURIComponent(incidentId)}/${incidentTabPath(tab)}` : `#${nextView}`;
    window.history.replaceState(null, "", hash);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectDetailTab(tab: IncidentTab): void {
    if (!selectedIncident) return;
    setDetailTab(tab);
    window.history.replaceState(null, "", `#incidents/${encodeURIComponent(selectedIncident.incident_id)}/${incidentTabPath(tab)}`);
  }

  async function request<T>(path: string): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "Your dashboard session expired." : response.status === 404 ? "That incident is no longer available." : "The dashboard could not load.");
    return response.json() as Promise<T>;
  }

  async function loadDashboard(nextFilters = emptyFilters): Promise<void> {
    const [nextOverview, nextIncidents] = await Promise.all([
      request<DashboardOverview>("/v1/dashboard/overview"),
      request<DashboardIncidentPage>(incidentUrl(nextFilters))
    ]);
    setOverview(nextOverview);
    setIncidents(nextIncidents.items);
    setNextCursor(nextIncidents.next_cursor);
    setRefreshedAt(new Date());
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await loadDashboard();
        const incidentId = incidentIdFromHash();
        if (!incidentId) return;
        const incident = await request<DashboardIncidentDetail>(`/v1/dashboard/incidents/${encodeURIComponent(incidentId)}`);
        if (!active) return;
        setSelectedIncident(incident);
        setDetailTab(incidentRouteFromHash()?.tab ?? "analysis");
        setView("detail");
      } catch (reason) {
        if (active && incidentIdFromHash()) {
          setError(reason instanceof Error ? reason.message : "The incident could not load.");
          navigate("investigations");
        }
      } finally {
        if (active) setCheckingSession(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function refreshDashboard(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await loadDashboard(filters);
      const incidentId = selectedIncident?.incident_id ?? incidentIdFromHash();
      if (incidentId) {
        const incident = await request<DashboardIncidentDetail>(`/v1/dashboard/incidents/${encodeURIComponent(incidentId)}`);
        setSelectedIncident(incident);
        setView("detail");
      } else {
        setSelectedIncident(undefined);
      }
    } catch (reason) {
      setOverview(undefined);
      setIncidents([]);
      setNextCursor(undefined);
      setSelectedIncident(undefined);
      setError(reason instanceof Error ? reason.message : "The dashboard could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function loadOverview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!key.trim()) {
      setError("Paste a read API key.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/dashboard/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.trim()}` },
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(response.status === 401 ? "That key cannot open the dashboard." : "The dashboard session could not start.");
      setKey("");
      setFilters(emptyFilters);
      navigate("overview");
      await loadDashboard();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The dashboard session could not start.");
    } finally {
      setLoading(false);
    }
  }

  async function applyFilters(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const page = await request<DashboardIncidentPage>(incidentUrl(filters));
      setIncidents(page.items);
      setNextCursor(page.next_cursor);
      setSelectedIncident(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The incident list could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function clearFilters(): Promise<void> {
    setFilters(emptyFilters);
    setLoading(true);
    setError("");
    try {
      const page = await request<DashboardIncidentPage>(incidentUrl(emptyFilters));
      setIncidents(page.items);
      setNextCursor(page.next_cursor);
      setSelectedIncident(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The incident list could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function openIncident(incidentId: string): Promise<void> {
    setDetailLoading(true);
    setError("");
    try {
      const incident = await request<DashboardIncidentDetail>(`/v1/dashboard/incidents/${encodeURIComponent(incidentId)}`);
      setSelectedIncident(incident);
      navigate("detail", incident.incident_id);
    } catch (reason) {
      setSelectedIncident(undefined);
      setError(reason instanceof Error ? reason.message : "The incident could not load.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadMoreIncidents(): Promise<void> {
    if (!nextCursor) return;
    setLoading(true);
    setError("");
    try {
      const page = await request<DashboardIncidentPage>(incidentUrl(filters, nextCursor));
      setIncidents((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The next incident page could not load.");
    } finally {
      setLoading(false);
    }
  }

  async function downloadIncidentReport(incidentId: string): Promise<void> {
    setReportLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/dashboard/incidents/${encodeURIComponent(incidentId)}/report`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(response.status === 401 ? "Your dashboard session expired." : "The incident report could not be generated.");
      const disposition = response.headers.get("content-disposition");
      const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `incidentiq-${incidentId}.pdf`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The incident report could not be generated.");
    } finally {
      setReportLoading(false);
    }
  }

  async function generateAiExplanation(incidentId: string): Promise<void> {
    setAiLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/dashboard/incidents/${encodeURIComponent(incidentId)}/ai-explanation`, {
        method: "POST",
        credentials: "same-origin"
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
        const apiMessage = typeof body?.message === "string" ? body.message : undefined;
        throw new Error(
          response.status === 401 ? "Your dashboard session expired." :
          response.status === 503 ? "AI explanations are not configured on the API server." :
          apiMessage ?? "The AI provider could not generate a valid evidence-bounded explanation."
        );
      }
      const explanation = await response.json() as AiExplanation;
      setSelectedIncident((current) => current?.incident_id === incidentId ? { ...current, ai_explanation: explanation } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The AI explanation could not be generated.");
    } finally {
      setAiLoading(false);
    }
  }

  async function signOut(): Promise<void> {
    await fetch(`${apiBaseUrl}/v1/dashboard/session`, { method: "DELETE", credentials: "same-origin" });
    setOverview(undefined);
    setIncidents([]);
    setNextCursor(undefined);
    setSelectedIncident(undefined);
    setFilters(emptyFilters);
    navigate("overview");
    setError("");
  }

  if (checkingSession) return <main className="loading-page"><div className="brand-mark">IQ</div><p>Restoring dashboard session…</p></main>;

  if (!overview) {
    return <main className="unlock-page">
      <section className="unlock-card">
        <div className="brand-mark">IQ</div>
        <span className="eyebrow">INCIDENT INTELLIGENCE</span>
        <h1>Welcome to IncidentIQ</h1>
        <p>Use a read-only key once to start an eight-hour secure browser session. The raw key is never saved by the dashboard.</p>
        <code>pnpm incidentiq keys create --scope read</code>
        <form onSubmit={loadOverview}>
          <label htmlFor="api-key">Read API key</label>
          <input id="api-key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="iiq_…" />
          <button disabled={loading}>{loading ? "Connecting…" : "Open dashboard"}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>;
  }

  const openIncidentCount = incidents.filter((incident) => incident.state === "open").length;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark small">IQ</div><div><strong>IncidentIQ</strong><span>Operations</span></div></div>
      <nav aria-label="Dashboard sections">
        <button className={view === "overview" ? "active" : ""} onClick={() => navigate("overview")}>Overview</button>
        <button className={view === "investigations" || view === "detail" ? "active" : ""} onClick={() => navigate("investigations")}>Investigations</button>
      </nav>
      <div className="sidebar-footer"><span>API target</span><code>{apiBaseUrl || "localhost:3000"}</code><small>v0.8.2</small></div>
    </aside>

    <main className="content">
      <header className="page-header">
        {view === "overview" ? <div><span className="eyebrow">SYSTEM OVERVIEW</span><h1>Operational coverage</h1><p>Services, environments, and evidence sources visible to this tenant.</p></div> : view === "investigations" ? <div><span className="eyebrow">INVESTIGATION WORKSPACE</span><h1>Incident investigations</h1><p>Filter saved incidents, then inspect the evidence and recommended next checks.</p></div> : <div><span className="eyebrow">INCIDENT DETAIL</span><h1>Incident investigation</h1><p>Review the analysis, recorded evidence, and optional AI second opinion.</p></div>}
        <div className="header-actions"><span className="live-status"><i />API connected</span><button className="secondary-button" onClick={refreshDashboard} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><button className="secondary-button" onClick={signOut}>Sign out</button></div>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}

      {view === "overview" && <>
        <section className="metrics" aria-label="Coverage summary">
          <Metric label="Open incidents" value={openIncidentCount} detail="in the loaded investigation page" />
          <Metric label="Services" value={overview.services.length} detail="reporting evidence" />
          <Metric label="Environments" value={overview.environments.length} detail="across this tenant" />
          <Metric label="Last refreshed" value={refreshedAt ? refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"} detail="browser session" />
        </section>

        <ServicesTable services={overview.services} />

        <section className="lower-grid">
          <EnvironmentPanel environments={overview.environments} />
          <IntegrationPanel integrations={overview.integrations} />
        </section>

        <section className="setup-callout">
          <div><span className="eyebrow">CONFIGURATION</span><h2>Connect another evidence source</h2><p>Add application errors, deployment context, Kubernetes failures, or Prometheus alerts using the integration guides.</p></div>
          <a href="https://github.com/Shreyanshi200/IncidentIQ/tree/main/docs/integrations" target="_blank" rel="noreferrer">Open integration guides ↗</a>
        </section>
      </>}

      {view === "investigations" && <IncidentPanel
        incidents={incidents}
        filters={filters}
        services={overview.services.map((service) => service.service)}
        environments={overview.environments.map((environment) => environment.environment)}
        sources={overview.integrations.map((integration) => integration.source)}
        loading={loading || detailLoading}
        nextCursor={nextCursor}
        onFiltersChange={setFilters}
        onApply={applyFilters}
        onClear={() => void clearFilters()}
        onOpen={(incidentId) => void openIncident(incidentId)}
        onLoadMore={() => void loadMoreIncidents()}
      />}

      {view === "detail" && selectedIncident && <IncidentDetail incident={selectedIncident} tab={detailTab} reportLoading={reportLoading} aiLoading={aiLoading} onBack={() => navigate("investigations")} onTabChange={selectDetailTab} onDownload={() => void downloadIncidentReport(selectedIncident.incident_id)} onGenerateAi={() => void generateAiExplanation(selectedIncident.incident_id)} />}
    </main>
  </div>;
}

function Metric({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function IncidentPanel({ incidents, filters, services, environments, sources, loading, nextCursor, onFiltersChange, onApply, onClear, onOpen, onLoadMore }: {
  incidents: DashboardIncident[];
  filters: IncidentFilters;
  services: string[];
  environments: string[];
  sources: string[];
  loading: boolean;
  nextCursor?: string;
  onFiltersChange: (filters: IncidentFilters) => void;
  onApply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onClear: () => void;
  onOpen: (incidentId: string) => void;
  onLoadMore: () => void;
}) {
  return <section className="panel data-panel incident-panel" id="incidents">
    <div className="panel-heading"><div><span className="eyebrow">INVESTIGATIONS</span><h2>Incident evidence</h2><p>Saved incidents. Select one to inspect the exact timeline used for its explanation.</p></div><span className="count-badge">{incidents.length}</span></div>
    <form className="filters" onSubmit={(event) => void onApply(event)}>
      <label>Service<select value={filters.service} onChange={(event) => onFiltersChange({ ...filters, service: event.target.value })}><option value="">All services</option>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label>
      <label>Environment<select value={filters.environment} onChange={(event) => onFiltersChange({ ...filters, environment: event.target.value })}><option value="">All environments</option>{environments.map((environment) => <option key={environment} value={environment}>{environment}</option>)}</select></label>
      <label>Evidence source<select value={filters.source} onChange={(event) => onFiltersChange({ ...filters, source: event.target.value })}><option value="">All sources</option>{sources.map((source) => <option key={source} value={source}>{sourceLabel(source)}</option>)}</select></label>
      <div className="filter-actions"><button disabled={loading}>{loading ? "Loading…" : "Apply filters"}</button><button type="button" className="text-button" onClick={onClear} disabled={loading}>Clear</button></div>
    </form>
    {incidents.length === 0 ? <EmptyState text="No saved incidents match these filters yet." /> : <><div className="table-scroll"><table className="incident-table"><thead><tr><th>Incident</th><th>Service</th><th>Evidence</th><th>Last activity</th><th aria-label="Open incident" /></tr></thead><tbody>{incidents.map((incident) => <tr key={incident.incident_id}><td><strong className="truncate" title={incident.incident_id}>{humanize(incident.leading_cause)}</strong><span className="row-subtitle"><i className={`severity-dot ${incident.confidence}`} />{incident.confidence} confidence · {incident.state}</span></td><td><strong>{incident.service}</strong><span className="row-subtitle">{incident.environment}</span></td><td>{incident.event_count} events</td><td><time title={formatDate(incident.last_event_at)}>{formatAge(incident.last_event_at)}</time></td><td><button className="row-action" onClick={() => onOpen(incident.incident_id)} disabled={loading}>Inspect</button></td></tr>)}</tbody></table></div>{nextCursor && <div className="load-more"><button className="secondary-button" onClick={onLoadMore} disabled={loading}>{loading ? "Loading…" : "Load 25 more"}</button></div>}</>}
  </section>;
}

function IncidentDetail({ incident, tab, reportLoading, aiLoading, onBack, onTabChange, onDownload, onGenerateAi }: { incident: DashboardIncidentDetail; tab: IncidentTab; reportLoading: boolean; aiLoading: boolean; onBack: () => void; onTabChange: (tab: IncidentTab) => void; onDownload: () => void; onGenerateAi: () => void }) {
  const sources = [...new Set(incident.timeline.map((event) => event.source))];
  const terms = evidenceTerms(incident);
  const openEvidence = (eventId: string) => {
    onTabChange("evidence");
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToEvidence(eventId)));
  };
  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs: IncidentTab[] = ["analysis", "evidence", "ai"];
    const current = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? tabs[(current + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(current + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    requestAnimationFrame(() => document.getElementById(`incident-tab-${next}`)?.focus());
  };
  return <section className="incident-detail" aria-label={`Incident investigation for ${incident.service}`}>
    <div className="detail-toolbar"><button className="back-button" onClick={onBack}>← Back to investigations</button><button className="secondary-button report-button" onClick={onDownload} disabled={reportLoading}>{reportLoading ? "Preparing report…" : "Download report"}</button></div>
    <div className="detail-heading">
      <div><span className="eyebrow">INCIDENT INVESTIGATION</span><h2>{incident.service} · {incident.environment}</h2><p><strong>{humanize(incident.leading_cause)}</strong> · {incident.confidence} confidence · {incident.state} incident</p></div>
    </div>
    <section className="detail-summary" aria-label="Incident summary"><Metric label="Opened" value={<RelativeAge value={incident.started_at} />} detail={formatDate(incident.started_at)} /><Metric label="Latest evidence" value={<RelativeAge value={incident.last_event_at} />} detail={formatDate(incident.last_event_at)} /><Metric label="Linked evidence" value={incident.event_count} detail={sources.map(sourceLabel).join(", ") || "no sources"} /><Metric label={incident.cross_service ? "Affected services" : "Status"} value={incident.cross_service ? incident.cross_service.services.length : incident.state} detail={incident.cross_service ? "evidence-backed links" : "automatic incident"} /></section>
    <div className="incident-tabs" id="incident-tabs" role="tablist" aria-label="Incident investigation sections" onKeyDown={handleTabKey}>
      <button id="incident-tab-analysis" role="tab" aria-selected={tab === "analysis"} aria-controls="incident-panel-analysis" tabIndex={tab === "analysis" ? 0 : -1} className={tab === "analysis" ? "active" : ""} onClick={() => onTabChange("analysis")}>Analysis</button>
      <button id="incident-tab-evidence" role="tab" aria-selected={tab === "evidence"} aria-controls="incident-panel-evidence" tabIndex={tab === "evidence" ? 0 : -1} className={tab === "evidence" ? "active" : ""} onClick={() => onTabChange("evidence")}>Evidence <span>{incident.event_count}</span></button>
      <button id="incident-tab-ai" role="tab" aria-selected={tab === "ai"} aria-controls="incident-panel-ai" tabIndex={tab === "ai" ? 0 : -1} className={tab === "ai" ? "active" : ""} onClick={() => onTabChange("ai")}>AI Review{incident.ai_explanation && <i aria-hidden="true" title="Generated" />}</button>
    </div>
    {tab === "analysis" && <div className="incident-tab-panel" id="incident-panel-analysis" role="tabpanel" aria-labelledby="incident-tab-analysis">
      {incident.cross_service && <CrossServiceEvidence context={incident.cross_service} timeline={incident.timeline} onEvidence={openEvidence} />}
      <InvestigationBrief incident={incident} terms={terms} onEvidence={openEvidence} />
      <section className="next-checks"><div><span className="eyebrow">VALIDATION PLAN</span><h2>Recommended next checks</h2><p>Run these in order before taking remediation action. They are evidence-based checks, not automated commands.</p></div>{incident.next_checks.length > 0 ? <ol>{incident.next_checks.map((check) => <li key={check}><HighlightedText text={check} terms={terms} /></li>)}</ol> : <p>Compare the evidence timeline with service logs and deployment state before taking action.</p>}</section>
    </div>}
    {tab === "evidence" && <div className="incident-tab-panel" id="incident-panel-evidence" role="tabpanel" aria-labelledby="incident-tab-evidence">
      <section className="timeline-section">
        <div><span className="eyebrow">ORDERED EVIDENCE</span><div className="heading-with-help"><h2>What IncidentIQ recorded</h2><DotLegend kind="evidence" /></div><p>Plain-language summaries are derived from stored fields. Expand an item to verify the untouched raw attributes.</p></div>
        <ol className="timeline">{incident.timeline.map((event) => <li key={event.event_id} id={`evidence-${event.event_id}`}><span className={`timeline-marker ${event.severity}`} /><article><div className="timeline-title"><strong>{humanize(event.event_type)}</strong><time title={formatDate(event.occurred_at)}>{formatDate(event.occurred_at)}</time></div><p className="event-explanation"><HighlightedText text={describeEvent(event)} terms={terms} /></p><p className="event-meta"><span className="source-chip">{sourceLabel(event.source)}</span>{event.version && <span className="event-context">v{event.version}</span>}{event.trace_id && <span className="event-context">{traceLabel(event.trace_id)}</span>}</p>{Object.keys(event.attributes).length > 0 && <details><summary>View raw evidence attributes</summary><pre>{JSON.stringify(event.attributes, null, 2)}</pre></details>}</article></li>)}</ol>
      </section>
    </div>}
    {tab === "ai" && <div className="incident-tab-panel" id="incident-panel-ai" role="tabpanel" aria-labelledby="incident-tab-ai"><AiExplanationPanel incident={incident} terms={terms} loading={aiLoading} onGenerate={onGenerateAi} onEvidence={openEvidence} /></div>}
  </section>;
}

function CrossServiceEvidence({ context, timeline, onEvidence }: { context: NonNullable<DashboardIncidentDetail["cross_service"]>; timeline: DashboardIncidentDetail["timeline"]; onEvidence: (eventId: string) => void }) {
  const timelineOrder = new Map(timeline.map((event, index) => [event.event_id, index]));
  const groups = new Map<string, GroupedCrossServiceLink & { trace_ids: Set<string> }>();
  for (const link of context.links) {
    const key = `${link.from_service}\u0000${link.to_service}`;
    const group = groups.get(key) ?? { from_service: link.from_service, to_service: link.to_service, evidence_ids: [], trace_count: 0, dependency_count: 0, trace_ids: new Set<string>() };
    group.evidence_ids.push(...link.evidence_ids);
    if (link.reason === "shared_trace" && link.trace_id) group.trace_ids.add(link.trace_id);
    if (link.reason === "declared_dependency") group.dependency_count += 1;
    group.trace_count = group.trace_ids.size;
    groups.set(key, group);
  }
  const serviceOrder = new Map(context.services.map((service, index) => [service.service, index]));
  const groupedLinks = [...groups.values()]
    .map(({ trace_ids: _traceIds, ...group }) => ({ ...group, evidence_ids: [...new Set(group.evidence_ids)].sort((left, right) => (timelineOrder.get(left) ?? 0) - (timelineOrder.get(right) ?? 0)) }))
    .sort((left, right) => (serviceOrder.get(left.from_service) ?? 0) - (serviceOrder.get(right.from_service) ?? 0) || (serviceOrder.get(left.to_service) ?? 0) - (serviceOrder.get(right.to_service) ?? 0));
  return <section className="cross-service-evidence">
    <div><span className="eyebrow">CROSS-SERVICE EVIDENCE</span><h2>Propagation path</h2><p>IncidentIQ linked these services only through recorded traces or explicit dependency failures. Expand a relationship only when you need to audit its citations.</p></div>
    <div className="service-scope" aria-label="Services in investigation">{context.services.map((service) => <article className={service.role} key={service.service}><strong>{service.service}</strong><span>{service.role === "primary" ? "investigation origin" : "linked"} · {service.event_count} events</span></article>)}</div>
    <div className="relationship-heading"><strong>Observed service relationships</strong><span>{groupedLinks.length} evidence-backed link{groupedLinks.length === 1 ? "" : "s"}</span></div>
    <ul className="cross-service-links">{groupedLinks.map((link) => <CrossServiceLinkCard key={`${link.from_service}-${link.to_service}`} link={link} timeline={timeline} onEvidence={onEvidence} />)}</ul>
    <p className="cross-service-footnote">The Evidence tab contains the complete ordered timeline; citations here are hidden by default to keep the topology readable.</p>
  </section>;
}

function CrossServiceLinkCard({ link, timeline, onEvidence }: { link: GroupedCrossServiceLink; timeline: DashboardIncidentDetail["timeline"]; onEvidence: (eventId: string) => void }) {
  return <li><div className="relationship-summary"><strong><span>{link.from_service}</span><i aria-hidden="true">→</i><span>{link.to_service}</span></strong><div>{link.trace_count > 0 && <span>{link.trace_count} shared trace{link.trace_count === 1 ? "" : "s"}</span>}{link.dependency_count > 0 && <span>{link.dependency_count} dependency confirmation{link.dependency_count === 1 ? "" : "s"}</span>}</div></div><details><summary>Inspect cited evidence ({link.evidence_ids.length})</summary><div className="relationship-evidence">{link.evidence_ids.map((eventId) => {
    const event = timeline.find((candidate) => candidate.event_id === eventId);
    return <button key={eventId} onClick={() => onEvidence(eventId)}>{humanize(event?.event_type ?? eventId)}{event?.trace_id ? ` · ${event.trace_id}` : ""}</button>;
  })}</div></details></li>;
}

function EvidenceLinks({ eventIds, incident, onEvidence, collapsed = false }: { eventIds: string[]; incident: DashboardIncidentDetail; onEvidence: (eventId: string) => void; collapsed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const uniqueIds = [...new Set(eventIds)];
  const visibleIds = expanded ? uniqueIds : uniqueIds.slice(0, 4);
  const evidenceButton = (eventId: string) => {
    const event = incident.timeline.find((candidate) => candidate.event_id === eventId);
    const context = event?.trace_id
      ? traceLabel(event.trace_id)
      : event?.version
        ? `v${event.version}`
        : event
          ? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(event.occurred_at))
          : undefined;
    const label = event ? `${humanize(event.event_type)} · ${event.service}${context ? ` · ${context}` : ""}` : eventId;
    return <button key={eventId} onClick={() => onEvidence(eventId)} title={event ? `${event.event_id} · ${formatDate(event.occurred_at)}` : eventId}>{label}</button>;
  };
  if (collapsed) return <details className="evidence-citations"><summary>{uniqueIds.length} cited event{uniqueIds.length === 1 ? "" : "s"}</summary><div className="evidence-links">{uniqueIds.map(evidenceButton)}</div></details>;
  return <div className="evidence-links">{visibleIds.map(evidenceButton)}{uniqueIds.length > 4 && <button className="evidence-more" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `View all ${uniqueIds.length} events`}</button>}</div>;
}

function AiExplanationPanel({ incident, terms, loading, onGenerate, onEvidence }: { incident: DashboardIncidentDetail; terms: string[]; loading: boolean; onGenerate: () => void; onEvidence: (eventId: string) => void }) {
  const explanation = incident.ai_explanation;
  if (!explanation) return <section className="ai-explanation ai-empty">
    <div><span className="eyebrow">OPTIONAL AI REVIEW</span><h2>Ask AI to explain this evidence</h2><p>The deterministic ranking above remains the source of truth. AI can turn only this incident's stored evidence into a second, cited investigation summary.</p></div>
    <button onClick={onGenerate} disabled={loading || !incident.ai_available}>{loading ? "Reviewing evidence…" : incident.ai_available ? "Generate AI explanation" : "AI not configured"}</button>
  </section>;

  return <section className="ai-explanation">
    <div className="ai-heading"><div><span className="eyebrow">AI EVIDENCE REVIEW</span><h2><HighlightedText text={explanation.likely_cause} terms={terms} /></h2><p><HighlightedText text={explanation.summary} terms={terms} /></p></div><span className="ai-label">AI-generated</span></div>
    <div className="ai-confidence"><strong>Why this confidence</strong><span><HighlightedText text={explanation.confidence_basis} terms={terms} /></span></div>
    <div className="ai-grid">
      <article><h3>Cited observations</h3>{explanation.evidence.map((item, index) => <div className="ai-item" key={`${item.claim}-${index}`}><p><HighlightedText text={item.claim} terms={terms} /></p><EvidenceLinks eventIds={item.evidence_ids} incident={incident} onEvidence={onEvidence} collapsed /></div>)}</article>
      <article><h3>Suggested checks</h3>{explanation.next_checks.map((item, index) => <div className="ai-item" key={`${item.action}-${index}`}><strong>{index + 1}. <HighlightedText text={item.action} terms={terms} /></strong><p><HighlightedText text={item.reason} terms={terms} /></p><EvidenceLinks eventIds={item.evidence_ids} incident={incident} onEvidence={onEvidence} collapsed /></div>)}</article>
    </div>
    <div className="ai-limitations"><strong>Known limits</strong><span><HighlightedText text={explanation.limitations.join(" ")} terms={terms} /></span></div>
    <small>Generated {formatDate(explanation.generated_at)} with {explanation.model}. Validate against the timeline before remediation.</small>
  </section>;
}

function InvestigationBrief({ incident, terms, onEvidence }: { incident: DashboardIncidentDetail; terms: string[]; onEvidence: (eventId: string) => void }) {
  const maxScore = Math.max(1, ...incident.brief.candidates.map((candidate) => candidate.score));
  return <section className="investigation-brief">
    <article className="brief-narrative">
      <span className="eyebrow">INVESTIGATION BRIEF</span>
      <h2>{incident.brief.headline}</h2>
      <p className="brief-summary"><HighlightedText text={incident.brief.summary} terms={terms} /></p>
      <div className="scope-note"><strong>Observed scope</strong><span>{incident.brief.observed_scope}</span></div>
    </article>
    <article className="evidence-reasoning">
      <span className="eyebrow">WHY THIS HYPOTHESIS</span>
      <h2>Evidence highlights</h2>
      {incident.brief.supporting_evidence.length === 0 ? <p>No decisive supporting factor is available yet.</p> : <ul>{incident.brief.supporting_evidence.map((factor, index) => <li key={`${factor.name}-${index}`}><div><strong>{factorLabel(factor.name)}</strong><span className="factor-score">+{factor.score}</span></div><p title={factor.description}><HighlightedText text={factorHighlight(factor.description)} terms={terms} /></p><EvidenceLinks eventIds={factor.evidence_ids} incident={incident} onEvidence={onEvidence} collapsed /></li>)}</ul>}
      {incident.brief.counterevidence.length > 0 && <div className="counterevidence"><strong>Evidence against this cause</strong>{incident.brief.counterevidence.map((factor, index) => <p key={`${factor.name}-${index}`}><HighlightedText text={`${factor.description} (${factor.score})`} terms={terms} /></p>)}</div>}
    </article>
    <article className="candidate-ranking">
      <div><span className="eyebrow">ALTERNATIVE HYPOTHESES</span><h2>Candidate ranking</h2><p>Scores prioritize investigation; they are not probabilities.</p></div>
      <div className="candidate-list">{incident.brief.candidates.map((candidate) => <div key={candidate.cause}><div><strong>{humanize(candidate.cause)}</strong><span>{candidate.score} points</span></div><span className="score-track"><i style={{ width: `${Math.max(0, candidate.score) / maxScore * 100}%` }} /></span></div>)}</div>
    </article>
  </section>;
}

function ServicesTable({ services }: { services: DashboardOverview["services"] }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = newestFirst(services);
  const visible = expanded ? sorted : sorted.slice(0, 6);
  return <section className="panel data-panel" id="services">
    <div className="panel-heading"><div><h2>Services</h2><p>Most recently active services and their evidence coverage.</p></div><span className="count-badge">{services.length}</span></div>
    {services.length === 0 ? <EmptyState text="No service evidence received yet." /> : <div className="table-scroll"><table><thead><tr><th>Service</th><th>Environment</th><th>Sources</th><th className="numeric">Events</th><th>Last evidence</th></tr></thead><tbody>{visible.map((service) => <tr key={service.service}><td><strong className="truncate" title={service.service}>{service.service}</strong></td><td>{service.environments.length === 1 ? service.environments[0] : `${service.environments.length} environments`}</td><td><div className="source-pills">{service.sources.slice(0, 3).map((source) => <span key={source}>{sourceLabel(source)}</span>)}</div></td><td className="numeric">{service.event_count}</td><td><time title={formatDate(service.last_event_at)}>{formatAge(service.last_event_at)}</time></td></tr>)}</tbody></table></div>}
    {services.length > 6 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Show recent only" : `View all ${services.length} services`}</button>}
  </section>;
}

function EnvironmentPanel({ environments }: { environments: DashboardOverview["environments"] }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = newestFirst(environments);
  const visible = expanded ? sorted : sorted.slice(0, 5);
  return <section className="panel" id="environments"><div className="panel-heading"><div><h2>Environments</h2><p>Evidence distribution by runtime environment.</p></div><span className="count-badge">{environments.length}</span></div>{environments.length === 0 ? <EmptyState text="No environments received yet." /> : <div className="compact-list">{visible.map((environment) => <article key={environment.environment}><div className="row-title"><strong className="truncate" title={environment.environment}>{environment.environment}</strong><time title={formatDate(environment.last_event_at)}>{formatAge(environment.last_event_at)}</time></div><span>{environment.service_count} services · {environment.event_count} events</span></article>)}</div>}{environments.length > 5 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Show recent only" : `View all ${environments.length} environments`}</button>}</section>;
}

function IntegrationPanel({ integrations }: { integrations: DashboardOverview["integrations"] }) {
  return <section className="panel" id="integrations"><div className="panel-heading"><div><div className="heading-with-help"><h2>Evidence source activity</h2><DotLegend kind="activity" /></div><p>Recent evidence shows delivery activity, not provider health.</p></div><span className="count-badge">{integrations.length}</span></div>{integrations.length === 0 ? <EmptyState text="No evidence sources have delivered events yet." /> : <div className="compact-list">{newestFirst(integrations).map((integration) => { const recent = integration.recent_event_count > 0; return <article key={integration.source}><div className="row-title"><strong><i className={`status-dot ${recent ? "active" : "quiet"}`} />{sourceLabel(integration.source)}</strong><time title={formatDate(integration.last_event_at)}>{formatAge(integration.last_event_at)}</time></div><span>{recent ? `${integration.recent_event_count} events in the last 24h` : "No evidence received in the last 24h"} · {integration.event_count} total</span></article>; })}</div>}</section>;
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

createRoot(document.getElementById("root")!).render(<App />);
