import type { IncidentIQClient } from "@incidentiq/node-sdk";
import type { NormalizedEvent } from "@incidentiq/event-schema";
import type { CollectorConfig } from "./config.js";
import { createKubernetesSignals } from "./signals.js";
import type { KubernetesDeployment, KubernetesJob, KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

export interface KubernetesList<T> {
  items: T[];
  resourceVersion?: string;
}

export interface KubernetesWatchRequest {
  abort(): void;
}

export type KubernetesWatchHandler<T> = (type: string, object: T, resourceVersion?: string) => void;

export interface KubernetesSource {
  listPods(namespace: string): Promise<KubernetesList<KubernetesPod>>;
  listEvents(namespace: string): Promise<KubernetesList<KubernetesWorkloadEvent>>;
  listDeployments(namespace: string): Promise<KubernetesList<KubernetesDeployment>>;
  listJobs(namespace: string): Promise<KubernetesList<KubernetesJob>>;
  watchPods(namespace: string, resourceVersion: string, onEvent: KubernetesWatchHandler<KubernetesPod>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest>;
  watchEvents(namespace: string, resourceVersion: string, onEvent: KubernetesWatchHandler<KubernetesWorkloadEvent>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest>;
  watchDeployments(namespace: string, resourceVersion: string, onEvent: KubernetesWatchHandler<KubernetesDeployment>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest>;
  watchJobs(namespace: string, resourceVersion: string, onEvent: KubernetesWatchHandler<KubernetesJob>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest>;
}

export interface CollectionResult {
  collected: number;
  delivered: boolean;
  pods: KubernetesPod[];
  events: KubernetesWorkloadEvent[];
  deployments: KubernetesDeployment[];
  jobs: KubernetesJob[];
  podResourceVersion?: string;
  eventResourceVersion?: string;
  deploymentResourceVersion?: string;
  jobResourceVersion?: string;
}

export async function collectOnce(source: KubernetesSource, client: IncidentIQClient, config: CollectorConfig, now = new Date()): Promise<CollectionResult> {
  const [podList, eventList, deploymentList, jobList] = await Promise.all([
    source.listPods(config.namespace),
    source.listEvents(config.namespace),
    source.listDeployments(config.namespace),
    source.listJobs(config.namespace)
  ]);
  const signals = createKubernetesSignals(config, podList.items, eventList.items, now, deploymentList.items, jobList.items);
  for (const signal of signals) client.track(signal);
  return {
    collected: signals.length,
    delivered: signals.length === 0 || await client.flush(),
    pods: podList.items,
    events: eventList.items,
    deployments: deploymentList.items,
    jobs: jobList.items,
    podResourceVersion: podList.resourceVersion,
    eventResourceVersion: eventList.resourceVersion,
    deploymentResourceVersion: deploymentList.resourceVersion,
    jobResourceVersion: jobList.resourceVersion
  };
}

export interface CheckpointedWatchSource<T> {
  list(): Promise<KubernetesList<T>>;
  watch(resourceVersion: string, onEvent: KubernetesWatchHandler<T>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest>;
}

export interface CheckpointedWatchOptions<T> {
  initialResourceVersion?: string;
  reconnectDelayMs: number;
  onList(items: T[]): void;
  onEvent(type: string, object: T): void;
  onWarning(error: unknown): void;
}

export interface CheckpointedWatch {
  stop(): void;
  done: Promise<void>;
}

interface PendingPodEvent {
  event: KubernetesWorkloadEvent;
  expiresAt: number;
}

function podEventKey(event: KubernetesWorkloadEvent): string | undefined {
  if (event.involvedObject?.kind !== "Pod") return undefined;
  const namespace = event.involvedObject.namespace ?? event.metadata?.namespace;
  const name = event.involvedObject.name;
  return namespace && name ? `${namespace}/${name}` : undefined;
}

function pendingEventKey(event: KubernetesWorkloadEvent): string | undefined {
  const workload = podEventKey(event);
  const eventId = event.metadata?.uid ?? event.metadata?.name;
  return workload && eventId ? `${workload}/${eventId}` : undefined;
}

export class PendingPodEvents {
  private readonly events = new Map<string, PendingPodEvent>();

  // shortcut: unmatched Pod Events stay in memory for five minutes; use durable storage if a Pod can appear later than that.
  constructor(private readonly maxAgeMs = 300_000, private readonly maxItems = 1_000) {}

  add(event: KubernetesWorkloadEvent, now = Date.now()): void {
    this.removeExpired(now);
    const key = pendingEventKey(event);
    if (!key) return;
    if (!this.events.has(key) && this.events.size === this.maxItems) this.events.delete(this.events.keys().next().value!);
    this.events.set(key, { event, expiresAt: now + this.maxAgeMs });
  }

  take(pod: KubernetesPod, now = Date.now()): KubernetesWorkloadEvent[] {
    this.removeExpired(now);
    const key = podKey(pod);
    if (!key) return [];
    const events: KubernetesWorkloadEvent[] = [];
    for (const [pendingKey, pending] of this.events) {
      if (!pendingKey.startsWith(`${key}/`)) continue;
      this.events.delete(pendingKey);
      events.push(pending.event);
    }
    return events;
  }

  remove(event: KubernetesWorkloadEvent): void {
    const key = pendingEventKey(event);
    if (key) this.events.delete(key);
  }

  removeForPod(pod: KubernetesPod): void {
    const key = podKey(pod);
    if (!key) return;
    for (const pendingKey of this.events.keys()) {
      if (pendingKey.startsWith(`${key}/`)) this.events.delete(pendingKey);
    }
  }

  private removeExpired(now: number): void {
    for (const [key, pending] of this.events) {
      if (pending.expiresAt <= now) this.events.delete(key);
    }
  }
}

function resourceVersionExpired(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const status = error as { code?: unknown; statusCode?: unknown };
    if (status.code === 410 || status.statusCode === 410) return true;
  }
  return error instanceof Error && /\b410\b/.test(error.message);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function startCheckpointedWatch<T>(source: CheckpointedWatchSource<T>, options: CheckpointedWatchOptions<T>): CheckpointedWatch {
  let stopped = false;
  let request: KubernetesWatchRequest | undefined;
  let checkpoint = options.initialResourceVersion;
  let relist = !checkpoint;

  const done = (async () => {
    while (!stopped) {
      try {
        if (relist) {
          const snapshot = await source.list();
          if (!snapshot.resourceVersion) throw new Error("Kubernetes list response did not include a resourceVersion");
          checkpoint = snapshot.resourceVersion;
          options.onList(snapshot.items);
          relist = false;
        }

        const error = await new Promise<unknown | undefined>((resolve) => {
          void source.watch(checkpoint!, (type, object, resourceVersion) => {
            if (resourceVersion) checkpoint = resourceVersion;
            if (type === "ERROR" && resourceVersionExpired(object)) relist = true;
            options.onEvent(type, object);
          }, resolve).then((watchRequest) => {
            request = watchRequest;
            if (stopped) watchRequest.abort();
          }).catch(resolve);
        });

        request = undefined;
        if (stopped) break;
        if (error != null) {
          options.onWarning(error);
          relist = resourceVersionExpired(error);
        }
      } catch (error) {
        if (stopped) break;
        options.onWarning(error);
        relist = true;
      }

      if (!stopped) await wait(options.reconnectDelayMs);
    }
  })();

  return {
    stop() {
      stopped = true;
      request?.abort();
    },
    done
  };
}

export function podKey(pod: KubernetesPod): string | undefined {
  const namespace = pod.metadata?.namespace;
  const name = pod.metadata?.name;
  return namespace && name ? `${namespace}/${name}` : undefined;
}

export function podSignals(config: CollectorConfig, pod: KubernetesPod, now = new Date()): NormalizedEvent[] {
  return createKubernetesSignals(config, [pod], [], now);
}

export function eventSignals(config: CollectorConfig, pods: Iterable<KubernetesPod>, event: KubernetesWorkloadEvent, now = new Date()): NormalizedEvent[] {
  return createKubernetesSignals(config, [...pods], [event], now);
}

export function deploymentSignals(config: CollectorConfig, deployment: KubernetesDeployment, now = new Date()): NormalizedEvent[] {
  return createKubernetesSignals(config, [], [], now, [deployment]);
}

export function jobSignals(config: CollectorConfig, job: KubernetesJob, now = new Date()): NormalizedEvent[] {
  return createKubernetesSignals(config, [], [], now, [], [job]);
}
