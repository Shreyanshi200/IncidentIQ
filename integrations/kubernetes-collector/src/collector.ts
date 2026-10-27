import type { IncidentIQClient } from "@incidentiq/node-sdk";
import type { CollectorConfig } from "./config.js";
import { createKubernetesSignals } from "./signals.js";
import type { KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

export interface KubernetesSource {
  listPods(namespace: string): Promise<KubernetesPod[]>;
  listEvents(namespace: string): Promise<KubernetesWorkloadEvent[]>;
}

export async function collectOnce(source: KubernetesSource, client: IncidentIQClient, config: CollectorConfig, now = new Date()): Promise<{ collected: number; delivered: boolean }> {
  const [pods, events] = await Promise.all([source.listPods(config.namespace), source.listEvents(config.namespace)]);
  const signals = createKubernetesSignals(config, pods, events, now);
  for (const signal of signals) client.track(signal);
  return { collected: signals.length, delivered: signals.length === 0 || await client.flush() };
}
