import type { IncidentFixture, NormalizedEvent } from "@incidentiq/event-schema";

export type Cause = "deployment_regression" | "resource_exhaustion" | "downstream_timeout" | "bad_release" | "ambiguous";

export interface ScoreFactor {
  name: "temporal_proximity" | "entity_match" | "version_match" | "propagation_order" | "resource_signal" | "route_specificity" | "counterevidence";
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
  timeline: NormalizedEvent[];
  leading_cause: Cause;
  confidence: "high" | "low";
  candidates: CandidateScore[];
  next_checks: string[];
}

const EVENT_WINDOW_MS = 10 * 60 * 1000;

function timestamp(event: NormalizedEvent): number {
  return Date.parse(event.occurred_at);
}

function sortTimeline(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => timestamp(left) - timestamp(right) || left.event_id.localeCompare(right.event_id));
}

function afterWithin(event: NormalizedEvent, reference: NormalizedEvent): boolean {
  const difference = timestamp(event) - timestamp(reference);
  return difference >= 0 && difference <= EVENT_WINDOW_MS;
}

function isApplicationError(event: NormalizedEvent): boolean {
  return event.source === "node_sdk" && event.event_type === "exception" && event.severity === "error";
}

function stringAttribute(event: NormalizedEvent, name: string): string | undefined {
  const value = event.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function candidate(cause: CandidateScore["cause"], factors: ScoreFactor[]): CandidateScore {
  return { cause, score: factors.reduce((total, factor) => total + factor.score, 0), factors };
}

function deploymentCandidate(timeline: NormalizedEvent[], routeSpecific: boolean): CandidateScore {
  const factors: ScoreFactor[] = [];
  for (const deployment of timeline.filter((event) => event.event_type === "deployment")) {
    const errors = timeline.filter((event) => isApplicationError(event) && event.service === deployment.service && afterWithin(event, deployment));
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

function resourceCandidate(timeline: NormalizedEvent[]): CandidateScore {
  const factors: ScoreFactor[] = [];
  for (const resource of timeline.filter((event) => event.event_type === "oom_killed" || event.event_type === "crash_loop_back_off")) {
    factors.push({ name: "resource_signal", score: 3, evidence_ids: [resource.event_id] });
    const error = timeline.find((event) => isApplicationError(event) && event.service === resource.service && afterWithin(event, resource));
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
    factors.push({ name: "entity_match", score: 3, evidence_ids: [downstream.event_id, upstream.event_id] });
  }
  return candidate("downstream_timeout", factors);
}

function nextChecks(cause: Cause): string[] {
  switch (cause) {
    case "deployment_regression":
      return ["Compare the deployed version with the previous database configuration.", "Validate a rollback or disable the changed connection-pool setting."];
    case "resource_exhaustion":
      return ["Inspect memory usage and limits for the affected workload.", "Review allocation patterns before increasing the memory limit."];
    case "downstream_timeout":
      return ["Check the downstream service latency and availability.", "Trace the failing dependency request before changing the upstream service."];
    case "bad_release":
      return ["Reproduce the failing route on the deployed version.", "Validate a rollback before releasing a corrected version."];
    case "ambiguous":
      return ["Compare deployment health with node and workload pressure.", "Collect more traces and resource events before choosing a remediation."];
  }
}

export function correlate(fixture: IncidentFixture): CorrelationResult {
  const timeline = sortTimeline(fixture.events);
  const candidates = [
    deploymentCandidate(timeline, false),
    resourceCandidate(timeline),
    downstreamCandidate(timeline),
    deploymentCandidate(timeline, true)
  ].sort((left, right) => right.score - left.score || left.cause.localeCompare(right.cause));
  const top = candidates[0];
  const second = candidates[1];
  const isAmbiguous = top.score < 5 || top.score - second.score < 3;

  const leadingCause = isAmbiguous ? "ambiguous" : top.cause;
  return {
    fixture_id: fixture.fixture_id,
    timeline,
    leading_cause: leadingCause,
    confidence: isAmbiguous ? "low" : "high",
    candidates,
    next_checks: nextChecks(leadingCause)
  };
}
