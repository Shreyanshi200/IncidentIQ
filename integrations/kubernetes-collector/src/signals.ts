import { createHash } from "node:crypto";
import type { NormalizedEvent } from "@incidentiq/event-schema";
import type { CollectorConfig } from "./config.js";
import type { KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

interface SignalInput {
  type: "oom_killed" | "pod_restart" | "crash_loop_back_off" | "failed_scheduling" | "unhealthy";
  severity: NormalizedEvent["severity"];
  occurredAt: string;
  namespace: string;
  pod: string;
  podUid: string;
  service: string;
  reason: string;
  identity: string;
  container?: string;
  message?: string;
  restartCount?: number;
}

function timestamp(value: string | Date | undefined, fallback: Date): string {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  return Number.isNaN(date.valueOf()) ? fallback.toISOString() : date.toISOString();
}

function eventId(...parts: string[]): string {
  return `k8s_${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function serviceFor(pod: KubernetesPod, serviceLabel: string): string | undefined {
  const service = pod.metadata?.labels?.[serviceLabel]?.trim();
  return service || undefined;
}

function podIdentity(pod: KubernetesPod, serviceLabel: string): { namespace: string; name: string; uid: string; service: string } | undefined {
  const namespace = pod.metadata?.namespace;
  const name = pod.metadata?.name;
  const uid = pod.metadata?.uid;
  const service = serviceFor(pod, serviceLabel);
  return namespace && name && uid && service ? { namespace, name, uid, service } : undefined;
}

function createSignal(config: CollectorConfig, input: SignalInput, receivedAt: string): NormalizedEvent {
  return {
    event_id: eventId(config.clusterName, input.podUid, input.type, input.identity),
    occurred_at: input.occurredAt,
    received_at: receivedAt,
    tenant_id: config.tenantId,
    environment: config.environment,
    service: input.service,
    source: "kubernetes",
    event_type: input.type,
    severity: input.severity,
    resource: `pod/${input.namespace}/${input.pod}`,
    attributes: {
      cluster: config.clusterName,
      namespace: input.namespace,
      pod: input.pod,
      reason: input.reason,
      ...(input.container ? { container: input.container } : {}),
      ...(input.message ? { message: input.message.slice(0, 1024) } : {}),
      ...(input.restartCount === undefined ? {} : { restart_count: input.restartCount })
    }
  };
}

function podSignals(config: CollectorConfig, pod: KubernetesPod, now: Date): NormalizedEvent[] {
  const identity = podIdentity(pod, config.serviceLabel);
  if (!identity) return [];
  const receivedAt = now.toISOString();
  const signals: NormalizedEvent[] = [];

  for (const status of pod.status?.containerStatuses ?? []) {
    const container = status.name;
    if (!container) continue;
    const terminated = status.state?.terminated ?? status.lastState?.terminated;
    if (terminated?.reason === "OOMKilled") {
      signals.push(createSignal(config, {
        type: "oom_killed", severity: "error", occurredAt: timestamp(terminated.finishedAt, now),
        namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
        reason: "OOMKilled", identity: `${container}:${timestamp(terminated.finishedAt, now)}:${status.restartCount ?? 0}`,
        container, message: terminated.message, restartCount: status.restartCount
      }, receivedAt));
    }
    if (status.state?.waiting?.reason === "CrashLoopBackOff") {
      signals.push(createSignal(config, {
        type: "crash_loop_back_off", severity: "error", occurredAt: timestamp(status.state.waiting.startedAt, now),
        namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
        reason: "CrashLoopBackOff", identity: `${container}:${status.restartCount ?? 0}`,
        container, message: status.state.waiting.message, restartCount: status.restartCount
      }, receivedAt));
    }
    if ((status.restartCount ?? 0) > 0) {
      signals.push(createSignal(config, {
        type: "pod_restart", severity: "warning", occurredAt: now.toISOString(),
        namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
        reason: "ContainerRestarted", identity: `${container}:${status.restartCount}`,
        container, restartCount: status.restartCount
      }, receivedAt));
    }
  }

  const unschedulable = pod.status?.conditions?.find((condition) => condition.type === "PodScheduled" && condition.status === "False" && condition.reason === "Unschedulable");
  if (unschedulable) {
    signals.push(createSignal(config, {
      type: "failed_scheduling", severity: "error", occurredAt: timestamp(unschedulable.lastTransitionTime, now),
      namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
      reason: unschedulable.reason ?? "Unschedulable", identity: timestamp(unschedulable.lastTransitionTime, now),
      message: unschedulable.message
    }, receivedAt));
  }
  return signals;
}

function eventType(event: KubernetesWorkloadEvent): SignalInput["type"] | undefined {
  if (event.reason === "FailedScheduling") return "failed_scheduling";
  if (event.reason === "OOMKilling" || event.message?.includes("OOMKilled")) return "oom_killed";
  if (event.reason === "BackOff" || event.message?.includes("CrashLoopBackOff")) return "crash_loop_back_off";
  if (event.reason === "Unhealthy") return "unhealthy";
  return undefined;
}

function eventSeverity(type: SignalInput["type"]): NormalizedEvent["severity"] {
  return type === "unhealthy" ? "warning" : "error";
}

function workloadEventSignals(config: CollectorConfig, pods: Map<string, KubernetesPod>, event: KubernetesWorkloadEvent, now: Date): NormalizedEvent[] {
  if (event.involvedObject?.kind !== "Pod") return [];
  const namespace = event.involvedObject.namespace ?? event.metadata?.namespace;
  const podName = event.involvedObject.name;
  const type = eventType(event);
  if (!namespace || !podName || !type) return [];
  const pod = pods.get(`${namespace}/${podName}`);
  const identity = pod ? podIdentity(pod, config.serviceLabel) : undefined;
  if (!identity) return [];
  const occurrence = event.series?.count ?? event.count ?? 1;
  const sourceUid = event.metadata?.uid ?? event.involvedObject.uid ?? event.metadata?.name;
  if (!sourceUid) return [];
  const occurredAt = timestamp(event.eventTime ?? event.series?.lastObservedTime ?? event.lastTimestamp ?? event.metadata?.creationTimestamp, now);
  return [createSignal(config, {
    type, severity: eventSeverity(type), occurredAt,
    namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
    reason: event.reason ?? type, identity: `${sourceUid}:${occurrence}`,
    message: event.message
  }, now.toISOString())];
}

export function createKubernetesSignals(config: CollectorConfig, pods: KubernetesPod[], events: KubernetesWorkloadEvent[], now = new Date()): NormalizedEvent[] {
  const podsByName = new Map(pods.flatMap((pod) => {
    const namespace = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    return namespace && name ? [[`${namespace}/${name}`, pod] as const] : [];
  }));
  const signals = [...pods.flatMap((pod) => podSignals(config, pod, now)), ...events.flatMap((event) => workloadEventSignals(config, podsByName, event, now))];
  return [...new Map(signals.map((signal) => [signal.event_id, signal])).values()];
}
