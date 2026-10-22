import type { CorrelationResult } from "@incidentiq/correlation";
import type { IncidentSummary } from "./database.js";

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export function formatInvestigation(result: CorrelationResult): string {
  const leading = result.candidates.find((candidate) => candidate.cause === result.leading_cause) ?? result.candidates[0];
  return [
    `Incident: ${result.fixture_id}`,
    `Likely cause: ${label(result.leading_cause)} (${result.confidence} confidence)`,
    "",
    "Timeline:",
    ...result.timeline.map((event) => `  ${event.occurred_at}  ${event.service}  ${event.event_type}  [${event.event_id}]`),
    "",
    "Ranked causes:",
    ...result.candidates.map((candidate) => `  ${label(candidate.cause)}: ${candidate.score}`),
    "",
    "Evidence:",
    ...(leading.factors.length > 0 ? leading.factors.map((factor) => `  ${label(factor.name)}: ${factor.score >= 0 ? "+" : ""}${factor.score} [${factor.evidence_ids.join(", ")}]`) : ["  No decisive evidence."]),
    "",
    "Next checks:",
    ...result.next_checks.map((check) => `  - ${check}`)
  ].join("\n");
}

export function formatIncidentList(incidents: IncidentSummary[]): string {
  if (incidents.length === 0) return "No saved incidents.";
  return [
    "ID\tSERVICE\tCAUSE\tCONFIDENCE\tSTATE",
    ...incidents.map((incident) => `${incident.incident_id}\t${incident.service}\t${incident.leading_cause}\t${incident.confidence}\t${incident.state}`)
  ].join("\n");
}
