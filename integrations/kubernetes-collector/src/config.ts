export interface CollectorConfig {
  apiKey: string;
  apiUrl?: string;
  tenantId: string;
  environment: string;
  clusterName: string;
  namespace: string;
  serviceLabel: string;
  pollIntervalMs: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readCollectorConfig(environment = process.env): CollectorConfig {
  const apiUrl = environment.INCIDENTIQ_API_URL?.trim();
  return {
    apiKey: required(environment, "INCIDENTIQ_API_KEY"),
    ...(apiUrl ? { apiUrl } : {}),
    tenantId: environment.INCIDENTIQ_TENANT_ID?.trim() || "local",
    environment: required(environment, "INCIDENTIQ_ENVIRONMENT"),
    clusterName: required(environment, "INCIDENTIQ_CLUSTER_NAME"),
    namespace: required(environment, "INCIDENTIQ_KUBERNETES_NAMESPACE"),
    serviceLabel: environment.INCIDENTIQ_SERVICE_LABEL?.trim() || "app.kubernetes.io/name",
    pollIntervalMs: positiveInteger(environment.INCIDENTIQ_POLL_INTERVAL_MS, "INCIDENTIQ_POLL_INTERVAL_MS", 30_000)
  };
}
