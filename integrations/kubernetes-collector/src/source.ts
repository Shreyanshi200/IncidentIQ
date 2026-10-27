import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { KubernetesSource } from "./collector.js";
import type { KubernetesPod, KubernetesWorkloadEvent } from "./types.js";

export function createKubernetesSource(): KubernetesSource {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const api = kubeConfig.makeApiClient(CoreV1Api);
  return {
    async listPods(namespace: string): Promise<KubernetesPod[]> {
      return (await api.listNamespacedPod({ namespace })).items as KubernetesPod[];
    },
    async listEvents(namespace: string): Promise<KubernetesWorkloadEvent[]> {
      return (await api.listNamespacedEvent({ namespace })).items as KubernetesWorkloadEvent[];
    }
  };
}
