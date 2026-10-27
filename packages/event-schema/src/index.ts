export const SCHEMA_VERSION = "0.0.3";

export interface NormalizedEvent {
  event_id: string;
  occurred_at: string;
  received_at: string;
  tenant_id: string;
  environment: string;
  service: string;
  source: "node_sdk" | "github_actions" | "kubernetes" | "internal";
  event_type: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  version?: string;
  trace_id?: string;
  resource?: string;
  attributes: Record<string, unknown>;
}

export interface IncidentFixture {
  fixture_id: string;
  scenario: string;
  expected_cause: string;
  events: NormalizedEvent[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const SOURCES = new Set<NormalizedEvent["source"]>(["node_sdk", "github_actions", "kubernetes", "internal"]);
const SEVERITIES = new Set<NormalizedEvent["severity"]>(["debug", "info", "warning", "error", "critical"]);
const RESOURCE_EVENT_TYPES = new Set(["oom_killed", "pod_restart", "crash_loop_back_off", "failed_scheduling", "unhealthy"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requireString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${field} must be a non-empty string`);
}

export function validateEvent(event: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(event)) return { valid: false, errors: ["event must be an object"] };

  for (const field of ["event_id", "tenant_id", "environment", "service", "source", "event_type", "severity"]) {
    requireString(event[field], field, errors);
  }
  if (!isIsoTimestamp(event.occurred_at)) errors.push("occurred_at must be an ISO timestamp");
  if (!isIsoTimestamp(event.received_at)) errors.push("received_at must be an ISO timestamp");
  if (typeof event.source !== "string" || !SOURCES.has(event.source as NormalizedEvent["source"])) errors.push("source must be a supported source");
  if (typeof event.severity !== "string" || !SEVERITIES.has(event.severity as NormalizedEvent["severity"])) errors.push("severity must be a supported severity");
  if (event.version !== undefined && typeof event.version !== "string") errors.push("version must be a string when present");
  if (event.trace_id !== undefined && typeof event.trace_id !== "string") errors.push("trace_id must be a string when present");
  if (event.resource !== undefined && typeof event.resource !== "string") errors.push("resource must be a string when present");
  if (!isObject(event.attributes)) errors.push("attributes must be an object");
  else {
    const attributes = JSON.stringify(event.attributes);
    if (typeof attributes !== "string" || Buffer.byteLength(attributes) > 16_384) errors.push("attributes must be at most 16 KiB");
  }

  return { valid: errors.length === 0, errors };
}

export function validateDeployment(event: unknown): ValidationResult {
  const errors = [...validateEvent(event).errors];
  const input = isObject(event) ? event : {};
  if (input.source !== "github_actions") errors.push("deployment source must be github_actions");
  if (input.event_type !== "deployment") errors.push("deployment event_type must be deployment");
  if (!isObject(input.attributes) || typeof input.attributes.state !== "string") errors.push("deployment attributes.state must be a string");
  return { valid: errors.length === 0, errors };
}

export function validateResource(event: unknown): ValidationResult {
  const errors = [...validateEvent(event).errors];
  const input = isObject(event) ? event : {};
  if (input.source !== "kubernetes") errors.push("resource source must be kubernetes");
  if (typeof input.event_type !== "string" || !RESOURCE_EVENT_TYPES.has(input.event_type)) errors.push("resource event_type must be a supported Kubernetes event");
  if (typeof input.resource !== "string" || input.resource === "") errors.push("resource must identify the workload");
  return { valid: errors.length === 0, errors };
}

export function validateIncident(incident: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(incident)) return { valid: false, errors: ["incident must be an object"] };
  for (const field of ["incident_id", "service", "environment", "state"]) requireString(incident[field], field, errors);
  if (!isIsoTimestamp(incident.started_at)) errors.push("started_at must be an ISO timestamp");
  return { valid: errors.length === 0, errors };
}

export function validateEvidence(evidence: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(evidence)) return { valid: false, errors: ["evidence must be an object"] };
  for (const field of ["evidence_id", "event_id", "factor"]) requireString(evidence[field], field, errors);
  return { valid: errors.length === 0, errors };
}

export function validateFixture(fixture: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(fixture)) return { valid: false, errors: ["fixture must be an object"] };
  for (const field of ["fixture_id", "scenario", "expected_cause"]) requireString(fixture[field], field, errors);
  if (!Array.isArray(fixture.events) || fixture.events.length === 0) errors.push("events must be a non-empty array");
  else {
    const eventIds = new Set<unknown>();
    fixture.events.forEach((event, index) => {
      const eventResult = validateEvent(event);
      for (const error of eventResult.errors) errors.push(`events[${index}]: ${error}`);
      const eventId = isObject(event) ? event.event_id : undefined;
      if (eventIds.has(eventId)) errors.push(`events[${index}]: event_id must be unique`);
      eventIds.add(eventId);
    });
  }
  return { valid: errors.length === 0, errors };
}
