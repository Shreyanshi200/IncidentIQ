import { createIncidentIQ } from "@incidentiq/node-sdk";
import { collectOnce } from "./collector.js";
import { readCollectorConfig } from "./config.js";
import { createKubernetesSource } from "./source.js";

const config = readCollectorConfig();
const client = createIncidentIQ({ apiKey: config.apiKey, apiUrl: config.apiUrl });
const source = createKubernetesSource();
let collecting = false;

async function collect(): Promise<void> {
  if (collecting) return;
  collecting = true;
  try {
    // shortcut: polling relies on API event-id deduplication; upgrade to Kubernetes watches when cluster-scale event volume needs it.
    const result = await collectOnce(source, client, config);
    if (result.collected > 0 && result.delivered) console.log(`IncidentIQ exported ${result.collected} Kubernetes workload signals.`);
    if (!result.delivered) console.warn("IncidentIQ could not export Kubernetes workload signals; they remain queued in memory.");
  } catch (error) {
    console.warn(`IncidentIQ could not collect Kubernetes workload signals: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    collecting = false;
  }
}

await collect();
const interval = setInterval(() => void collect(), config.pollIntervalMs);

async function shutdown(): Promise<void> {
  clearInterval(interval);
  await client.shutdown();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
