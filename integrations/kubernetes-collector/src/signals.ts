import { createHash } from "node:crypto";
import type { NormalizedEvent } from "@incidentiq/event-schema";
import type { CollectorConfig } from "./config.js";
import type { KubernetesDeployment, KubernetesJob, KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

interface SignalInput {
  type: "oom_killed" | "pod_restart" | "crash_loop_back_off" | "failed_scheduling" | "unhealthy" | "image_pull_back_off" | "pod_evicted" | "failed_volume_mount" | "deployment_rollout_failed" | "job_failed";
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
  resourceType?: "deployment" | "job";
}

function timestamp(value: string | Date | undefined, fallback: Date): string {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  return Number.isNaN(date.valueOf()) ? fallback.toISOString() : date.toISOString();
}

function eventId(...parts: string[]): string {
  return `k8s_${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function serviceFor(workload: { metadata?: { labels?: Record<string, string> } }, serviceLabel: string): string | undefined {
  const service = workload.metadata?.labels?.[serviceLabel]?.trim();
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
  const resourceType = input.resourceType ?? "pod";
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
    resource: `${resourceType}/${input.namespace}/${input.pod}`,
    attributes: {
      cluster: config.clusterName,
      namespace: input.namespace,
      [resourceType]: input.pod,
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
    if (status.state?.waiting?.reason === "ImagePullBackOff" || status.state?.waiting?.reason === "ErrImagePull") {
      signals.push(createSignal(config, {
        type: "image_pull_back_off", severity: "error", occurredAt: timestamp(status.state.waiting.startedAt, now),
        namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
        reason: status.state.waiting.reason, identity: `${container}:${status.state.waiting.reason}:${status.restartCount ?? 0}`,
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
  if (pod.status?.reason === "Evicted") {
    signals.push(createSignal(config, {
      type: "pod_evicted", severity: "error", occurredAt: timestamp(pod.metadata?.creationTimestamp, now),
      namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
      reason: "Evicted", identity: "Evicted", message: pod.status.message
    }, receivedAt));
  }
  return signals;
}

function workloadIdentity(workload: { metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, string> } }, serviceLabel: string): { namespace: string; name: string; uid: string; service: string } | undefined {
  const namespace = workload.metadata?.namespace;
  const name = workload.metadata?.name;
  const uid = workload.metadata?.uid;
  const service = serviceFor(workload, serviceLabel);
  return namespace && name && uid && service ? { namespace, name, uid, service } : undefined;
}

function deploymentSignals(config: CollectorConfig, deployment: KubernetesDeployment, now: Date): NormalizedEvent[] {
  const identity = workloadIdentity(deployment, config.serviceLabel);
  const stalled = deployment.status?.conditions?.find((condition) => condition.type === "Progressing" && condition.status === "False" && condition.reason === "ProgressDeadlineExceeded");
  if (!identity || !stalled) return [];
  const occurredAt = timestamp(stalled.lastTransitionTime, now);
  return [createSignal(config, {
    type: "deployment_rollout_failed", severity: "error", occurredAt,
    namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
    reason: stalled.reason ?? "ProgressDeadlineExceeded", identity: (stalled.reason ?? "ProgressDeadlineExceeded") + ":" + occurredAt,
    message: stalled.message, resourceType: "deployment"
  }, now.toISOString())];
}

function jobSignals(config: CollectorConfig, job: KubernetesJob, now: Date): NormalizedEvent[] {
  const identity = workloadIdentity(job, config.serviceLabel);
  const failed = job.status?.conditions?.find((condition) => condition.type === "Failed" && condition.status === "True");
  if (!identity || !failed) return [];
  const occurredAt = timestamp(failed.lastTransitionTime, now);
  return [createSignal(config, {
    type: "job_failed", severity: "error", occurredAt,
    namespace: identity.namespace, pod: identity.name, podUid: identity.uid, service: identity.service,
    reason: failed.reason ?? "JobFailed", identity: (failed.reason ?? "JobFailed") + ":" + occurredAt,
    message: failed.message, resourceType: "job"
  }, now.toISOString())];
}

function eventType(event: KubernetesWorkloadEvent): SignalInput["type"] | undefined {
  if (event.reason === "FailedScheduling") return "failed_scheduling";
  if (event.reason === "OOMKilling" || event.message?.includes("OOMKilled")) return "oom_killed";
  if ((event.reason === "BackOff" && /pulling image/i.test(event.message ?? "")) || /ErrImagePull|ImagePullBackOff|Failed to pull image/i.test(event.message ?? "")) return "image_pull_back_off";
  if (event.reason === "BackOff" || event.message?.includes("CrashLoopBackOff")) return "crash_loop_back_off";
  if (event.reason === "Unhealthy") return "unhealthy";
  if (event.reason === "Evicted") return "pod_evicted";
  if (event.reason === "FailedMount" || event.reason === "FailedAttachVolume") return "failed_volume_mount";
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

export function createKubernetesSignals(config: CollectorConfig, pods: KubernetesPod[], events: KubernetesWorkloadEvent[], now = new Date(), deployments: KubernetesDeployment[] = [], jobs: KubernetesJob[] = []): NormalizedEvent[] {
  const podsByName = new Map(pods.flatMap((pod) => {
    const namespace = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    return namespace && name ? [[`${namespace}/${name}`, pod] as const] : [];
  }));
  const signals = [
    ...pods.flatMap((pod) => podSignals(config, pod, now)),
    ...events.flatMap((event) => workloadEventSignals(config, podsByName, event, now)),
    ...deployments.flatMap((deployment) => deploymentSignals(config, deployment, now)),
    ...jobs.flatMap((job) => jobSignals(config, job, now))
  ];
  return [...new Map(signals.map((signal) => [signal.event_id, signal])).values()];
}
