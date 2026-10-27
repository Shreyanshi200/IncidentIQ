export interface KubernetesPod {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string | Date;
  };
  status?: {
    containerStatuses?: Array<{
      name?: string;
      restartCount?: number;
      state?: {
        waiting?: { reason?: string; message?: string; startedAt?: string | Date };
        terminated?: { reason?: string; message?: string; finishedAt?: string | Date };
      };
      lastState?: {
        terminated?: { reason?: string; message?: string; finishedAt?: string | Date };
      };
    }>;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string | Date;
    }>;
  };
}

export interface KubernetesWorkloadEvent {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string | Date;
  };
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string };
  reason?: string;
  message?: string;
  count?: number;
  eventTime?: string | Date;
  lastTimestamp?: string | Date;
  series?: { count?: number; lastObservedTime?: string | Date };
}
