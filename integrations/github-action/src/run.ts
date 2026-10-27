import { createIncidentIQ } from "@incidentiq/node-sdk";
import { createDeploymentEvent } from "./event.js";

function input(name: string): string {
  const value = process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function run(log: (message: string) => void = console.log, warn: (message: string) => void = console.warn): Promise<void> {
  try {
    const client = createIncidentIQ({ apiKey: input("api-key"), apiUrl: input("api-url") });
    const event = createDeploymentEvent({
      tenantId: input("tenant-id"),
      service: input("service"),
      environment: input("environment"),
      status: process.env.INPUT_DEPLOYMENT_STATUS?.trim() || "success",
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF,
      workflow: process.env.GITHUB_WORKFLOW,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      serverUrl: process.env.GITHUB_SERVER_URL,
      actor: process.env.GITHUB_ACTOR
    });
    client.track(event);
    if (await client.shutdown()) log(`IncidentIQ recorded deployment context for ${event.service}`);
    else warn("IncidentIQ deployment context was not exported: the API did not accept the event");
  } catch (error) {
    warn(`IncidentIQ deployment context was not exported: ${error instanceof Error ? error.message : String(error)}`);
  }
}
