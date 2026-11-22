# Changelog

Notable IncidentIQ changes are recorded here. Planned work belongs in the [release roadmap](docs/roadmap.md), not in the completed release history.

## 0.8.2 - Cross-service evidence correlation

- Linked service-local incidents only through shared traces or recorded dependency failures within the same tenant, environment, and evidence window.
- Added unified multi-service investigations, compact propagation paths, and expandable relationship citations without merging stored incidents.
- Added tenant-safe fixture ingestion through the authenticated API and an 86-event commerce cascade for rigorous validation.
- Grounded AI citations in the exact incident event-ID set and invalidated cached explanations when linked evidence changes.
- Redesigned PDF reports around a concise executive summary, service propagation, optional AI review, validation plan, and one chronological timeline.
- Updated npm release automation to skip publishing when public package contents have not changed.

## 0.8.1 - Operational hardening

- Added labelled, tenant-selectable API keys with optional expiry, metadata listing, and confirmed revocation.
- Added transactional, dry-run-first evidence retention that preserves keys and evidence linked to retained incidents.
- Added bounded AI timeout, input size, output, reasoning, timeline, hourly usage, and duplicate-generation controls.
- Added explicit request-body limits, dashboard session throttling, request IDs, defensive response headers, production JSON request logs, and graceful shutdown.
- Split liveness and PostgreSQL-backed readiness probes while retaining the existing health endpoint as a compatibility alias.
- Made normal CLI commands run without rebuilding the monorepo, with an explicit development command for rebuild-on-demand execution.
- Added an operations guide covering safe rotation, retention scheduling, probes, and configuration boundaries.

## 0.8.0 - Evidence-bounded AI explanations

- Added optional, operator-requested OpenAI explanations grounded in one tenant-scoped incident.
- Required structured output with valid event-ID citations and rejected incomplete or ungrounded responses.
- Cached valid explanations until new evidence changes the incident, while preserving deterministic fallback.
- Added cited AI guidance to the dashboard and to PDF reports generated afterward.
- Expanded the canonical fixtures into a four-scenario AI validation pack covering release, downstream, resource, and ambiguous failures.
- Added a 40-event, multi-service payment-pool cascade for rigorous human-versus-platform investigation testing.
- Aggregated repeated correlation factors, capped volume-based score inflation, and clarified cross-service trace evidence in dashboards and reports.
- Removed fixture-authored scenario conclusions from investigation briefs and now derive downstream summaries from correlated event pairs.
- Added explicit tenant-data cleanup for repeatable local tests while preserving API keys and migrations.
- Split incident detail into deep-linked Analysis, Evidence, and AI Review tabs, with cross-tab evidence navigation and consistent resource highlighting.

### Documentation

- Reorganized the README with concise navigation, a two-column product gallery, a Quick start, and dedicated architecture, changelog, and roadmap references.

## 0.7.1 - Dashboard investigations

- Added filtered and cursor-paginated incident browsing.
- Added a dedicated investigation view with evidence-backed briefs, alternative candidate ranking, contextual next checks, and a readable ordered timeline.
- Added tenant-scoped PDF incident reports and evidence-source activity.
- Preserved deep-linked incidents across browser refreshes.

## 0.7.0 - Operational dashboard

- Added the single-operator React dashboard and secure read-key browser sessions.
- Added service, environment, and evidence-source coverage views.
- Added production guidance for serving the static dashboard beside the API.

## 0.6.0 - Automatic incidents

- Added automatic incident opening for newly accepted error and critical events.
- Added configurable activity-gap grouping and preceding-context lookback.
- Stored unified timelines, deterministic cause rankings, and contextual next checks.

## 0.5.0 - Public Node.js SDK

- Published `@incidentiqhq/node-sdk` and `@incidentiqhq/event-schema` to npm.
- Added trusted publishing and external-install verification guidance.

## 0.4.2 - Prometheus Alertmanager

- Added authenticated Alertmanager webhook ingestion.
- Added normalized CPU throttling, memory saturation, latency, and error-rate evidence with firing and resolved lifecycle states.

## 0.4.1 - Checkpointed Kubernetes watches

- Replaced Kubernetes polling with reconnecting Pod, Event, Deployment, and Job watches.
- Added image-pull, eviction, volume-mount, deployment-rollout, and Job-failure signals alongside the original Pod signals.
- Added resource-version checkpoint and reconnect handling.

## 0.4.0 - Kubernetes workload evidence

- Added the namespace-scoped, read-only Kubernetes collector.
- Added OOM, crash-loop, restart, failed-scheduling, and unhealthy Pod signals.

## 0.3.0 - GitHub Actions deployment context

- Added the fail-open GitHub Action for deployment status, commit, workflow, actor, and run metadata.
- Added cloud-neutral deployment workflow guidance.

## 0.2.0 - Node.js SDK foundation

- Added bounded in-memory batching, periodic flush, graceful shutdown, and fail-open delivery.
- Added the demo service used to verify real application integration.

## 0.1.0 - Authenticated ingestion API

- Added bearer-key event ingestion with tenant validation, schema validation, receipt timestamps, secret-field redaction, and duplicate protection.
- Added API health checks and container publishing.

## 0.0.4 - Investigation CLI

- Added readable local incident explanations, ordered evidence, ranked candidates, and suggested checks.

## 0.0.3 - Deterministic correlation

- Added evidence-based cause candidates and explainable scoring factors.

## 0.0.2 - PostgreSQL persistence

- Added migrations and idempotent event storage.

## 0.0.1 - Event contracts and fixtures

- Added the canonical normalized-event contract and versioned incident fixtures.
