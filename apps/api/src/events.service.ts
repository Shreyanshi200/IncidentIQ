import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { type NormalizedEvent, validateEvent } from "@incidentiq/event-schema";
import { ApiKeysService } from "./api-keys.service.js";
import { DatabaseService } from "./database.js";

const MAX_EVENTS_PER_BATCH = 100;
const SECRET_FIELD = /authorization|cookie|api[_-]?key|token|password|secret/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item)]));
}

@Injectable()
export class EventsService {
  constructor(private readonly database: DatabaseService, private readonly apiKeys: ApiKeysService) {}

  async ingest(authorization: string | undefined, payload: unknown): Promise<{ accepted: number; duplicates: number }> {
    const key = authorization?.replace(/^Bearer\s+/i, "");
    const apiKey = key ? await this.apiKeys.findActive(key) : undefined;
    if (!apiKey || apiKey.scope !== "ingest") throw new UnauthorizedException("A valid ingestion API key is required");
    if (!isObject(payload) || !Array.isArray(payload.events) || payload.events.length === 0 || payload.events.length > MAX_EVENTS_PER_BATCH) {
      throw new BadRequestException(`events must contain between 1 and ${MAX_EVENTS_PER_BATCH} records`);
    }

    const receivedAt = new Date().toISOString();
    const events: NormalizedEvent[] = [];
    const errors: string[] = [];
    payload.events.forEach((input, index) => {
      const event = isObject(input) ? { ...input, received_at: receivedAt } : input;
      const result = validateEvent(event);
      if (!result.valid) errors.push(...result.errors.map((error) => `events[${index}]: ${error}`));
      else if ((event as NormalizedEvent).tenant_id !== apiKey.tenant_id) errors.push(`events[${index}]: tenant_id does not match API key`);
      else events.push({ ...(event as NormalizedEvent), attributes: redact((event as NormalizedEvent).attributes) as Record<string, unknown> });
    });
    if (errors.length > 0) throw new BadRequestException({ message: "Invalid event batch", errors });

    let accepted = 0;
    for (const event of events) {
      const inserted = await this.database.db
        .insertInto("source_events")
        .values({ ...event, version: event.version ?? null, trace_id: event.trace_id ?? null, resource: event.resource ?? null })
        .onConflict((conflict) => conflict.column("event_id").doNothing())
        .returning("event_id")
        .executeTakeFirst();
      if (inserted) accepted += 1;
    }
    return { accepted, duplicates: events.length - accepted };
  }
}
