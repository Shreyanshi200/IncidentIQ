import type { NormalizedEvent } from "@incidentiq/event-schema";

export interface IncidentIQOptions {
  apiKey: string;
  apiUrl?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  fetch?: typeof globalThis.fetch;
}

export interface IncidentIQClient {
  track(event: NormalizedEvent): void;
  flush(): Promise<boolean>;
  shutdown(): Promise<boolean>;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function createIncidentIQ(options: IncidentIQOptions): IncidentIQClient {
  if (!options.apiKey) throw new Error("apiKey is required");
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const flushIntervalMs = positiveInteger(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS, "flushIntervalMs");
  const maxQueueSize = positiveInteger(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, "maxQueueSize");
  const send = options.fetch ?? globalThis.fetch;
  if (!send) throw new Error("fetch is required");

  const endpoint = `${(options.apiUrl ?? "http://localhost:3000").replace(/\/$/, "")}/v1/events/batch`;
  const queue: NormalizedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | undefined;

  function schedule(): void {
    if (timer || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function flush(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (queue.length === 0) return true;

    const batch = queue.splice(0, batchSize);
    inFlight = (async () => {
      try {
        const response = await send(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ events: batch })
        });
        if (!response.ok) throw new Error(`IncidentIQ ingestion failed: ${response.status}`);
        return true;
      } catch {
        queue.unshift(...batch);
        if (queue.length > maxQueueSize) queue.length = maxQueueSize;
        return false;
      } finally {
        inFlight = undefined;
        if (queue.length >= batchSize) void flush();
        else schedule();
      }
    })();
    return inFlight;
  }

  return {
    track(event): void {
      if (queue.length === maxQueueSize) queue.shift();
      queue.push(event);
      if (queue.length >= batchSize) void flush();
      else schedule();
    },
    flush,
    async shutdown(): Promise<boolean> {
      if (timer) clearTimeout(timer);
      timer = undefined;
      return flush();
    }
  };
}
