import { createIncidentIQ } from "@incidentiq/node-sdk";
import { collectOnce, deploymentSignals, eventSignals, jobSignals, PendingPodEvents, podKey, podSignals, startCheckpointedWatch } from "./collector.js";
import { readCollectorConfig } from "./config.js";
import { createKubernetesSource } from "./source.js";
import type { KubernetesPod } from "./types.js";

const config = readCollectorConfig();
const client = createIncidentIQ({ apiKey: config.apiKey, apiUrl: config.apiUrl });
const source = createKubernetesSource();
const pods = new Map<string, KubernetesPod>();
const pendingEvents = new PendingPodEvents();
let delivery = Promise.resolve();
let shuttingDown = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error) ?? String(error);
}

function replacePods(items: KubernetesPod[]): void {
  pods.clear();
  for (const pod of items) {
    const key = podKey(pod);
    if (!key) continue;
    pods.set(key, pod);
    exportPendingEvents(pod);
  }
}

function exportSignals(signals: ReturnType<typeof podSignals>): void {
  if (signals.length === 0) return;
  delivery = delivery.catch(() => undefined).then(async () => {
    for (const signal of signals) client.track(signal);
    if (await client.flush()) console.log(`IncidentIQ exported ${signals.length} Kubernetes workload signals.`);
    else console.warn("IncidentIQ could not export Kubernetes workload signals; they remain queued in memory.");
  }).catch((error) => console.warn(`IncidentIQ could not export Kubernetes workload signals: ${errorMessage(error)}`));
}

function exportPendingEvents(pod: KubernetesPod): void {
  for (const event of pendingEvents.take(pod)) exportSignals(eventSignals(config, pods.values(), event));
}

function retainEventIfPodMissing(event: Parameters<typeof eventSignals>[2]): boolean {
  const namespace = event.involvedObject?.namespace ?? event.metadata?.namespace;
  const name = event.involvedObject?.name;
  if (event.involvedObject?.kind === "Pod" && namespace && name && !pods.has(`${namespace}/${name}`)) {
    pendingEvents.add(event);
    return true;
  }
  return false;
}

function exportEvent(event: Parameters<typeof eventSignals>[2]): void {
  if (retainEventIfPodMissing(event)) return;
  exportSignals(eventSignals(config, pods.values(), event));
}

let initialPodResourceVersion: string | undefined;
let initialEventResourceVersion: string | undefined;
let initialDeploymentResourceVersion: string | undefined;
let initialJobResourceVersion: string | undefined;
try {
  const initial = await collectOnce(source, client, config);
  replacePods(initial.pods);
  for (const event of initial.events) retainEventIfPodMissing(event);
  initialPodResourceVersion = initial.podResourceVersion;
  initialEventResourceVersion = initial.eventResourceVersion;
  initialDeploymentResourceVersion = initial.deploymentResourceVersion;
  initialJobResourceVersion = initial.jobResourceVersion;
  if (initial.collected > 0 && initial.delivered) console.log(`IncidentIQ exported ${initial.collected} Kubernetes workload signals.`);
  if (!initial.delivered) console.warn("IncidentIQ could not export Kubernetes workload signals; they remain queued in memory.");
} catch (error) {
  console.warn(`IncidentIQ could not collect Kubernetes workload signals: ${errorMessage(error)}`);
}

const podWatch = startCheckpointedWatch({
  list: () => source.listPods(config.namespace),
  watch: (checkpoint, onEvent, onDone) => source.watchPods(config.namespace, checkpoint, onEvent, onDone)
}, {
  initialResourceVersion: initialPodResourceVersion,
  reconnectDelayMs: config.watchReconnectDelayMs,
  onList(items) {
    replacePods(items);
    for (const pod of items) exportSignals(podSignals(config, pod));
  },
  onEvent(type, pod) {
    const key = podKey(pod);
    if (!key || type === "BOOKMARK" || type === "ERROR") return;
    if (type === "DELETED") {
      pods.delete(key);
      pendingEvents.removeForPod(pod);
      return;
    }
    pods.set(key, pod);
    exportPendingEvents(pod);
    exportSignals(podSignals(config, pod));
  },
  onWarning(error) {
    console.warn(`IncidentIQ Pod watch disconnected: ${errorMessage(error)}`);
  }
});

const eventWatch = startCheckpointedWatch({
  list: () => source.listEvents(config.namespace),
  watch: (checkpoint, onEvent, onDone) => source.watchEvents(config.namespace, checkpoint, onEvent, onDone)
}, {
  initialResourceVersion: initialEventResourceVersion,
  reconnectDelayMs: config.watchReconnectDelayMs,
  onList(items) {
    for (const event of items) exportEvent(event);
  },
  onEvent(type, event) {
    if (type === "BOOKMARK" || type === "ERROR") return;
    if (type === "DELETED") {
      pendingEvents.remove(event);
      return;
    }
    exportEvent(event);
  },
  onWarning(error) {
    console.warn(`IncidentIQ Event watch disconnected: ${errorMessage(error)}`);
  }
});

const deploymentWatch = startCheckpointedWatch({
  list: () => source.listDeployments(config.namespace),
  watch: (checkpoint, onEvent, onDone) => source.watchDeployments(config.namespace, checkpoint, onEvent, onDone)
}, {
  initialResourceVersion: initialDeploymentResourceVersion,
  reconnectDelayMs: config.watchReconnectDelayMs,
  onList(items) {
    for (const deployment of items) exportSignals(deploymentSignals(config, deployment));
  },
  onEvent(type, deployment) {
    if (type === "BOOKMARK" || type === "ERROR" || type === "DELETED") return;
    exportSignals(deploymentSignals(config, deployment));
  },
  onWarning(error) {
    console.warn(`IncidentIQ Deployment watch disconnected: ${errorMessage(error)}`);
  }
});

const jobWatch = startCheckpointedWatch({
  list: () => source.listJobs(config.namespace),
  watch: (checkpoint, onEvent, onDone) => source.watchJobs(config.namespace, checkpoint, onEvent, onDone)
}, {
  initialResourceVersion: initialJobResourceVersion,
  reconnectDelayMs: config.watchReconnectDelayMs,
  onList(items) {
    for (const job of items) exportSignals(jobSignals(config, job));
  },
  onEvent(type, job) {
    if (type === "BOOKMARK" || type === "ERROR" || type === "DELETED") return;
    exportSignals(jobSignals(config, job));
  },
  onWarning(error) {
    console.warn(`IncidentIQ Job watch disconnected: ${errorMessage(error)}`);
  }
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  podWatch.stop();
  eventWatch.stop();
  deploymentWatch.stop();
  jobWatch.stop();
  await Promise.all([podWatch.done, eventWatch.done, deploymentWatch.done, jobWatch.done]);
  await delivery;
  await client.shutdown();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
