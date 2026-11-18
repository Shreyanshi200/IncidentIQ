import { createHash } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { NormalizedEvent } from "@incidentiq/event-schema";
import { EventsService } from "./events.service.js";

const MAX_ALERTS_PER_WEBHOOK = 1_000;
const EVENT_BATCH_SIZE = 100;
const INCIDENTIQ_SIGNALS = new Set(["cpu_throttling", "memory_saturation", "latency_spike", "error_rate_spike"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown, field: string, required = true): Record<string, string> {
  if (value === undefined && !required) return {};
  if (!isObject(value)) throw new BadRequestException(`${field} must be an object`);
  const record = Object.entries(value).flatMap(([key, item]) => typeof item === "string" ? [[key, item] as const] : []);
  if (record.length !== Object.keys(value).length) throw new BadRequestException(`${field} values must be strings`);
  return Object.fromEntries(record);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequestException(`${field} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const input = requiredString(value, field);
  if (Number.isNaN(Date.parse(input))) throw new BadRequestException(`${field} must be an ISO timestamp`);
  return new Date(input).toISOString();
}

function boundedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 20)
    .map(([key, value]) => [key.slice(0, 128), value.slice(0, 256)]));
}

function severity(status: string, labels: Record<string, string>): NormalizedEvent["severity"] {
  if (status === "resolved") return "info";
  switch (labels.severity?.toLowerCase()) {
    case "critical": return "critical";
    case "warning": return "warning";
    case "info": return "info";
    default: return "error";
  }
}

function eventId(fingerprint: string, startsAt: string, status: string): string {
  return `am_${createHash("sha256").update(`${fingerprint}\u0000${startsAt}\u0000${status}`).digest("hex")}`;
}

export function normalizeAlertmanagerWebhook(payload: unknown, tenantId: string, now = new Date()): NormalizedEvent[] {
  if (!isObject(payload) || payload.version !== "4" || !Array.isArray(payload.alerts) || payload.alerts.length === 0 || payload.alerts.length > MAX_ALERTS_PER_WEBHOOK) {
    throw new BadRequestException("Alertmanager v4 payload must contain between 1 and 1000 alerts");
  }
  return payload.alerts.map((input, index): NormalizedEvent => {
    if (!isObject(input)) throw new BadRequestException(`alerts[${index}] must be an object`);
    const status = requiredString(input.status, `alerts[${index}].status`);
    if (status !== "firing" && status !== "resolved") throw new BadRequestException(`alerts[${index}].status must be firing or resolved`);
    const labels = stringRecord(input.labels, `alerts[${index}].labels`);
    const annotations = stringRecord(input.annotations, `alerts[${index}].annotations`, false);
    const alertName = requiredString(labels.alertname, `alerts[${index}].labels.alertname`);
    const service = requiredString(labels.service, `alerts[${index}].labels.service`);
    const namespace = requiredString(labels.namespace, `alerts[${index}].labels.namespace`);
    const fingerprint = requiredString(input.fingerprint, `alerts[${index}].fingerprint`);
    const startsAt = timestamp(input.startsAt, `alerts[${index}].startsAt`);
    const endsAt = typeof input.endsAt === "string" && !Number.isNaN(Date.parse(input.endsAt)) ? new Date(input.endsAt).toISOString() : undefined;
    const eventType = labels.incidentiq_signal && INCIDENTIQ_SIGNALS.has(labels.incidentiq_signal) ? labels.incidentiq_signal : "prometheus_alert";
    const occurredAt = status === "resolved" && endsAt ? endsAt : startsAt;
    return {
      event_id: eventId(fingerprint, startsAt, status),
      occurred_at: occurredAt,
      received_at: now.toISOString(),
      tenant_id: tenantId,
      environment: labels.environment?.trim() || "production",
      service,
      source: "alertmanager",
      event_type: eventType,
      severity: severity(status, labels),
      resource: `service/${namespace}/${service}`,
      attributes: {
        alert_name: alertName,
        alert_status: status,
        fingerprint,
        namespace,
        labels: boundedRecord(labels),
        annotations: boundedRecord(annotations),
        ...(typeof input.generatorURL === "string" && input.generatorURL ? { generator_url: input.generatorURL.slice(0, 2_048) } : {}),
        starts_at: startsAt,
        ...(endsAt ? { ends_at: endsAt } : {})
      }
    };
  });
}

@Injectable()
export class AlertmanagerService {
  constructor(private readonly events: EventsService) {}

  async ingest(authorization: string | undefined, payload: unknown): Promise<{ accepted: number; duplicates: number }> {
    const apiKey = await this.events.authenticate(authorization);
    const alerts = normalizeAlertmanagerWebhook(payload, apiKey.tenant_id);
    let accepted = 0;
    let duplicates = 0;
    for (let start = 0; start < alerts.length; start += EVENT_BATCH_SIZE) {
      const result = await this.events.ingestForApiKey(apiKey, { events: alerts.slice(start, start + EVENT_BATCH_SIZE) });
      accepted += result.accepted;
      duplicates += result.duplicates;
    }
    return { accepted, duplicates };
  }
}
