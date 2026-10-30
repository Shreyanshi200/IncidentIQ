import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig, Watch } from "@kubernetes/client-node";
import type { KubernetesSource, KubernetesWatchHandler, KubernetesWatchRequest } from "./collector.js";
import type { KubernetesDeployment, KubernetesJob, KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

function resourceVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("metadata" in value)) return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null || !("resourceVersion" in metadata)) return undefined;
  const version = (metadata as { resourceVersion?: unknown }).resourceVersion;
  return typeof version === "string" && version !== "" ? version : undefined;
}

function watchResource<T>(watch: Watch, path: string, checkpoint: string, onEvent: KubernetesWatchHandler<T>, onDone: (error?: unknown) => void): Promise<KubernetesWatchRequest> {
  return watch.watch(path, { resourceVersion: checkpoint, allowWatchBookmarks: true }, (type, object, status) => {
    onEvent(type, object as T, resourceVersion(status) ?? resourceVersion(object));
  }, onDone);
}

export function createKubernetesSource(): KubernetesSource {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const api = kubeConfig.makeApiClient(CoreV1Api);
  const apps = kubeConfig.makeApiClient(AppsV1Api);
  const batch = kubeConfig.makeApiClient(BatchV1Api);
  const watch = new Watch(kubeConfig);
  return {
    async listPods(namespace) {
      const result = await api.listNamespacedPod({ namespace });
      return { items: result.items as KubernetesPod[], resourceVersion: result.metadata?.resourceVersion };
    },
    async listEvents(namespace) {
      const result = await api.listNamespacedEvent({ namespace });
      return { items: result.items as KubernetesWorkloadEvent[], resourceVersion: result.metadata?.resourceVersion };
    },
    async listDeployments(namespace) {
      const result = await apps.listNamespacedDeployment({ namespace });
      return { items: result.items as KubernetesDeployment[], resourceVersion: result.metadata?.resourceVersion };
    },
    async listJobs(namespace) {
      const result = await batch.listNamespacedJob({ namespace });
      return { items: result.items as KubernetesJob[], resourceVersion: result.metadata?.resourceVersion };
    },
    watchPods(namespace, checkpoint, onEvent, onDone) {
      return watchResource(watch, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, checkpoint, onEvent, onDone);
    },
    watchEvents(namespace, checkpoint, onEvent, onDone) {
      return watchResource(watch, `/api/v1/namespaces/${encodeURIComponent(namespace)}/events`, checkpoint, onEvent, onDone);
    },
    watchDeployments(namespace, checkpoint, onEvent, onDone) {
      return watchResource(watch, `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`, checkpoint, onEvent, onDone);
    },
    watchJobs(namespace, checkpoint, onEvent, onDone) {
      return watchResource(watch, `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, checkpoint, onEvent, onDone);
    }
  };
}
