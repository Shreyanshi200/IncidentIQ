import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@incidentiq/event-schema";

export interface DeploymentContext {
  tenantId: string;
  service: string;
  environment: string;
  status: string;
  repository?: string;
  sha?: string;
  ref?: string;
  workflow?: string;
  runId?: string;
  runAttempt?: string;
  serverUrl?: string;
  actor?: string;
}

export function createDeploymentEvent(context: DeploymentContext, now = new Date()): NormalizedEvent {
  const runUrl = context.repository && context.runId ? `${context.serverUrl ?? "https://github.com"}/${context.repository}/actions/runs/${context.runId}` : undefined;
  const failed = ["failure", "failed", "cancelled"].includes(context.status.toLowerCase());
  return {
    event_id: randomUUID(),
    occurred_at: now.toISOString(),
    received_at: now.toISOString(),
    tenant_id: context.tenantId,
    environment: context.environment,
    service: context.service,
    source: "github_actions",
    event_type: "deployment",
    severity: failed ? "error" : "info",
    version: context.sha,
    attributes: {
      deployment_status: context.status,
      repository: context.repository,
      commit_sha: context.sha,
      ref: context.ref,
      workflow: context.workflow,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      run_url: runUrl,
      actor: context.actor
    }
  };
}
