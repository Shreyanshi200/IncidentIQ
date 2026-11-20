import type { IncidentFixture, NormalizedEvent } from "@incidentiqhq/event-schema";

export type Cause = "deployment_regression" | "resource_exhaustion" | "downstream_timeout" | "bad_release" | "ambiguous";

export interface ScoreFactor {
  name: "temporal_proximity" | "entity_match" | "version_match" | "propagation_order" | "trace_link" | "resource_signal" | "route_specificity" | "counterevidence";
  score: number;
  evidence_ids: string[];
}

export interface CandidateScore {
  cause: Exclude<Cause, "ambiguous">;
  score: number;
  factors: ScoreFactor[];
}

export interface CorrelationResult {
  fixture_id: string;
  scenario: string;
  correlation_window_ms: number;
  timeline: NormalizedEvent[];
  leading_cause: Cause;
  confidence: "high" | "low";
  candidates: CandidateScore[];
  next_checks: string[];
}

const EVENT_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPEATED_FACTOR_OCCURRENCES = 3;

export interface CorrelationOptions {
  eventWindowMs?: number;
}

function timestamp(event: NormalizedEvent): number {
  return Date.parse(event.occurred_at);
}

function sortTimeline(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => timestamp(left) - timestamp(right) || left.event_id.localeCompare(right.event_id));
}

function afterWithin(event: NormalizedEvent, reference: NormalizedEvent, eventWindowMs: number): boolean {
  const difference = timestamp(event) - timestamp(reference);
  return difference >= 0 && difference <= eventWindowMs;
}

function isApplicationError(event: NormalizedEvent): boolean {
  return event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical");
}

function stringAttribute(event: NormalizedEvent, name: string): string | undefined {
  const value = event.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function aggregateFactors(factors: ScoreFactor[]): ScoreFactor[] {
  const grouped = new Map<ScoreFactor["name"], ScoreFactor & { occurrences: number }>();
  for (const factor of factors) {
    const current = grouped.get(factor.name);
    if (!current) {
      grouped.set(factor.name, { ...factor, evidence_ids: [...new Set(factor.evidence_ids)], occurrences: 1 });
      continue;
    }
    if (current.occurrences < MAX_REPEATED_FACTOR_OCCURRENCES) current.score += factor.score;
    current.occurrences += 1;
    current.evidence_ids = [...new Set([...current.evidence_ids, ...factor.evidence_ids])];
  }
  return [...grouped.values()].map(({ occurrences: _occurrences, ...factor }) => factor);
}

function candidate(cause: CandidateScore["cause"], factors: ScoreFactor[]): CandidateScore {
  const aggregated = aggregateFactors(factors);
  return { cause, score: aggregated.reduce((total, factor) => total + factor.score, 0), factors: aggregated };
}

function deploymentCandidate(timeline: NormalizedEvent[], routeSpecific: boolean, eventWindowMs: number): CandidateScore {
  const factors: ScoreFactor[] = [];
  for (const deployment of timeline.filter((event) => event.event_type === "deployment")) {
    const errors = timeline.filter((event) => isApplicationError(event) && event.service === deployment.service && afterWithin(event, deployment, eventWindowMs));
    const relevantErrors = errors.filter((event) => Boolean(stringAttribute(event, "route")) === routeSpecific);
    if (relevantErrors.length === 0) continue;
    // shortcut: each deployment uses its first matching error; aggregate windows once live telemetry arrives.
    const error = relevantErrors[0];
    factors.push({ name: "temporal_proximity", score: 3, evidence_ids: [deployment.event_id, error.event_id] });
    factors.push({ name: "entity_match", score: 2, evidence_ids: [deployment.event_id, error.event_id] });
    if (deployment.version && deployment.version === error.version) factors.push({ name: "version_match", score: 2, evidence_ids: [deployment.event_id, error.event_id] });
    if (routeSpecific) factors.push({ name: "route_specificity", score: 3, evidence_ids: [error.event_id] });
    const priorError = timeline.find((event) => isApplicationError(event) && event.service === deployment.service && timestamp(event) < timestamp(deployment));
    if (priorError) factors.push({ name: "counterevidence", score: -3, evidence_ids: [priorError.event_id, deployment.event_id] });
  }
  return candidate(routeSpecific ? "bad_release" : "deployment_regression", factors);
}

function resourceCandidate(timeline: NormalizedEvent[], eventWindowMs: number): CandidateScore {
  const factors: ScoreFactor[] = [];
  for (const resource of timeline.filter((event) => event.event_type === "oom_killed" || event.event_type === "crash_loop_back_off")) {
    factors.push({ name: "resource_signal", score: 3, evidence_ids: [resource.event_id] });
    const error = timeline.find((event) => isApplicationError(event) && event.service === resource.service && afterWithin(event, resource, eventWindowMs));
    if (error) {
      factors.push({ name: "temporal_proximity", score: 2, evidence_ids: [resource.event_id, error.event_id] });
      factors.push({ name: "entity_match", score: 2, evidence_ids: [resource.event_id, error.event_id] });
    }
  }
  return candidate("resource_exhaustion", factors);
}

function downstreamCandidate(timeline: NormalizedEvent[]): CandidateScore {
  const factors: ScoreFactor[] = [];
  const errors = timeline.filter(isApplicationError);
  for (const upstream of errors) {
    const dependency = stringAttribute(upstream, "dependency");
    const downstream = errors.find((event) => event.service === dependency && event.trace_id && event.trace_id === upstream.trace_id && timestamp(event) < timestamp(upstream));
    if (!downstream) continue;
    factors.push({ name: "propagation_order", score: 4, evidence_ids: [downstream.event_id, upstream.event_id] });
    factors.push({ name: "trace_link", score: 3, evidence_ids: [downstream.event_id, upstream.event_id] });
  }
  return candidate("downstream_timeout", factors);
}

function nextChecks(cause: Cause, timeline: NormalizedEvent[]): string[] {
  const deployment = timeline.find((event) => event.event_type === "deployment");
  const error = timeline.find(isApplicationError);
  const dependencyError = timeline.find((event) => isApplicationError(event) && Boolean(stringAttribute(event, "dependency")));
  const resource = timeline.find((event) => event.event_type === "oom_killed" || event.event_type === "crash_loop_back_off");
  const version = error?.version ?? deployment?.version;
  const route = error ? stringAttribute(error, "route") : undefined;
  const dependency = dependencyError ? stringAttribute(dependencyError, "dependency") : undefined;
  const commit = (deployment ? stringAttribute(deployment, "commit_sha") ?? stringAttribute(deployment, "commit") : undefined)?.slice(0, 12);

  switch (cause) {
    case "deployment_regression":
      return [
        `Compare version ${version ?? "from the deployment evidence"} with the previous release, including runtime configuration and dependency changes.`,
        `Review the deployment diff${commit ? ` for commit ${commit}` : ""} beside the first application error, then identify the first changed code or configuration path.`,
        "If the failure is absent on the previous version, validate a rollback in a controlled environment before changing infrastructure."
      ];
    case "resource_exhaustion":
      return [
        `Inspect memory usage, requests, and limits for ${resource?.resource ?? "the affected workload"} around the first resource failure.`,
        "Compare container restarts and allocation growth with the application errors in this evidence window.",
        "Confirm whether memory usage grows again after restart before increasing limits or changing application allocation behavior."
      ];
    case "downstream_timeout":
      return [
        `Check latency, errors, and saturation for ${dependency ?? "the named downstream dependency"} during this incident window.`,
        `Follow trace ${dependencyError?.trace_id ?? "from the linked error"} from the downstream failure back to the affected service.`,
        "Verify timeout and retry behavior before changing the upstream service or increasing its timeout."
      ];
    case "bad_release":
      return [
        `Reproduce ${route ?? "the first failing request"} on version ${version ?? "from the deployment evidence"} and compare it with the previous release.`,
        `Review the deployment diff${commit ? ` for commit ${commit}` : ""}, focusing on the failing route and its configuration or dependencies.`,
        "If the route succeeds on the previous version, validate rollback safety before releasing a correction."
      ];
    case "ambiguous":
      return [
        "Compare the timing of deployment, application, workload, and alert evidence; no candidate is decisively ahead yet.",
        "Collect the missing trace, resource, or pre-change baseline needed to separate the top two candidates.",
        "Avoid remediation until one hypothesis is supported by evidence that the competing hypothesis cannot explain."
      ];
  }
}

export function correlate(fixture: IncidentFixture, options: CorrelationOptions = {}): CorrelationResult {
  const eventWindowMs = options.eventWindowMs ?? EVENT_WINDOW_MS;
  if (!Number.isFinite(eventWindowMs) || eventWindowMs <= 0) throw new Error("eventWindowMs must be a positive number");
  const timeline = sortTimeline(fixture.events);
  const candidates = [
    deploymentCandidate(timeline, false, eventWindowMs),
    resourceCandidate(timeline, eventWindowMs),
    downstreamCandidate(timeline),
    deploymentCandidate(timeline, true, eventWindowMs)
  ].sort((left, right) => right.score - left.score || left.cause.localeCompare(right.cause));
  const top = candidates[0];
  const second = candidates[1];
  const isAmbiguous = top.score < 5 || top.score - second.score < 3;

  const leadingCause = isAmbiguous ? "ambiguous" : top.cause;
  return {
    fixture_id: fixture.fixture_id,
    scenario: fixture.scenario,
    correlation_window_ms: eventWindowMs,
    timeline,
    leading_cause: leadingCause,
    confidence: isAmbiguous ? "low" : "high",
    candidates,
    next_checks: nextChecks(leadingCause, timeline)
  };
}
