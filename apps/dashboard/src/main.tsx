import { type FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface DashboardOverview {
  services: Array<{ service: string; environments: string[]; event_count: number; last_event_at: string; sources: string[] }>;
  environments: Array<{ environment: string; service_count: number; event_count: number; last_event_at: string }>;
  integrations: Array<{ source: string; event_count: number; last_event_at: string }>;
}

const apiBaseUrl = (import.meta.env.VITE_INCIDENTIQ_API_URL ?? "").replace(/\/$/, "");

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

function App() {
  const [key, setKey] = useState("");
  const [overview, setOverview] = useState<DashboardOverview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date>();

  async function requestOverview(): Promise<DashboardOverview> {
    const response = await fetch(`${apiBaseUrl}/v1/dashboard/overview`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "Your dashboard session expired." : "The dashboard could not load.");
    return response.json() as Promise<DashboardOverview>;
  }

  useEffect(() => {
    let active = true;
    void requestOverview()
      .then((result) => {
        if (!active) return;
        setOverview(result);
        setRefreshedAt(new Date());
      })
      .catch(() => undefined)
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  async function refreshOverview(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setOverview(await requestOverview());
      setRefreshedAt(new Date());
    } catch (reason) {
      setOverview(undefined);
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
      setOverview(await requestOverview());
      setRefreshedAt(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The dashboard session could not start.");
    } finally {
      setLoading(false);
    }
  }

  async function signOut(): Promise<void> {
    await fetch(`${apiBaseUrl}/v1/dashboard/session`, { method: "DELETE", credentials: "same-origin" });
    setOverview(undefined);
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

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark small">IQ</div><div><strong>IncidentIQ</strong><span>Operations</span></div></div>
      <nav aria-label="Dashboard sections">
        <a className="active" href="#overview">Overview</a>
        <a href="#services">Services</a>
        <a href="#integrations">Integrations</a>
      </nav>
      <div className="sidebar-footer"><span>API target</span><code>{apiBaseUrl || "localhost:3000"}</code><small>v0.7.0</small></div>
    </aside>

    <main className="content" id="overview">
      <header className="page-header">
        <div><span className="eyebrow">SYSTEM OVERVIEW</span><h1>Operational coverage</h1><p>Services and evidence currently visible to this tenant.</p></div>
        <div className="header-actions"><span className="live-status"><i />API connected</span><button className="secondary-button" onClick={refreshOverview} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><button className="secondary-button" onClick={signOut}>Sign out</button></div>
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}

      <section className="metrics" aria-label="Coverage summary">
        <Metric label="Services" value={overview.services.length} detail="reporting evidence" />
        <Metric label="Environments" value={overview.environments.length} detail="across this tenant" />
        <Metric label="Evidence sources" value={overview.integrations.length} detail="currently connected" />
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
    </main>
  </div>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function ServicesTable({ services }: { services: DashboardOverview["services"] }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = newestFirst(services);
  const visible = expanded ? sorted : sorted.slice(0, 6);
  return <section className="panel data-panel" id="services">
    <div className="panel-heading"><div><h2>Services</h2><p>Most recently active services and their evidence coverage.</p></div><span className="count-badge">{services.length}</span></div>
    {services.length === 0 ? <EmptyState text="No service evidence received yet." /> : <div className="table-scroll"><table><thead><tr><th>Service</th><th>Environment</th><th>Sources</th><th className="numeric">Events</th><th>Last evidence</th></tr></thead><tbody>{visible.map((service) => <tr key={service.service}><td><strong className="truncate" title={service.service}>{service.service}</strong></td><td>{service.environments.length === 1 ? service.environments[0] : `${service.environments.length} environments`}</td><td><div className="source-pills">{service.sources.slice(0, 3).map((source) => <span key={source}>{humanize(source)}</span>)}</div></td><td className="numeric">{service.event_count}</td><td><time title={formatDate(service.last_event_at)}>{formatAge(service.last_event_at)}</time></td></tr>)}</tbody></table></div>}
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
  return <section className="panel" id="integrations"><div className="panel-heading"><div><h2>Evidence sources</h2><p>Integrations that have delivered telemetry.</p></div><span className="count-badge">{integrations.length}</span></div>{integrations.length === 0 ? <EmptyState text="No integrations have delivered evidence yet." /> : <div className="compact-list">{newestFirst(integrations).map((integration) => <article key={integration.source}><div className="row-title"><strong><i className="status-dot" />{humanize(integration.source)}</strong><time title={formatDate(integration.last_event_at)}>{formatAge(integration.last_event_at)}</time></div><span>{integration.event_count} events received</span></article>)}</div>}</section>;
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

createRoot(document.getElementById("root")!).render(<App />);
