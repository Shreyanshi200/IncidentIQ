import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
var __webpack_exports__ = {};

;// CONCATENATED MODULE: ../../packages/node-sdk/dist/src/index.js
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function createIncidentIQ(options) {
    if (!options.apiKey)
        throw new Error("apiKey is required");
    const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    const flushIntervalMs = positiveInteger(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS, "flushIntervalMs");
    const maxQueueSize = positiveInteger(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, "maxQueueSize");
    const send = options.fetch ?? globalThis.fetch;
    if (!send)
        throw new Error("fetch is required");
    const endpoint = `${(options.apiUrl ?? "http://localhost:3000").replace(/\/$/, "")}/v1/events/batch`;
    const queue = [];
    let timer;
    let inFlight;
    function schedule() {
        if (timer || queue.length === 0)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            void flush();
        }, flushIntervalMs);
        timer.unref?.();
    }
    async function flush() {
        if (inFlight)
            return inFlight;
        if (queue.length === 0)
            return;
        const batch = queue.splice(0, batchSize);
        inFlight = (async () => {
            try {
                const response = await send(endpoint, {
                    method: "POST",
                    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
                    body: JSON.stringify({ events: batch })
                });
                if (!response.ok)
                    throw new Error(`IncidentIQ ingestion failed: ${response.status}`);
            }
            catch {
                queue.unshift(...batch);
                if (queue.length > maxQueueSize)
                    queue.length = maxQueueSize;
            }
            finally {
                inFlight = undefined;
                if (queue.length >= batchSize)
                    void flush();
                else
                    schedule();
            }
        })();
        return inFlight;
    }
    return {
        track(event) {
            if (queue.length === maxQueueSize)
                queue.shift();
            queue.push(event);
            if (queue.length >= batchSize)
                void flush();
            else
                schedule();
        },
        flush,
        async shutdown() {
            if (timer)
                clearTimeout(timer);
            timer = undefined;
            await flush();
        }
    };
}

;// CONCATENATED MODULE: external "node:crypto"
const external_node_crypto_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:crypto");
;// CONCATENATED MODULE: ./build/src/event.js

function createDeploymentEvent(context, now = new Date()) {
    const runUrl = context.repository && context.runId ? `${context.serverUrl ?? "https://github.com"}/${context.repository}/actions/runs/${context.runId}` : undefined;
    const failed = ["failure", "failed", "cancelled"].includes(context.status.toLowerCase());
    return {
        event_id: (0,external_node_crypto_namespaceObject.randomUUID)(),
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

;// CONCATENATED MODULE: ./build/src/index.js


function input(name) {
    const value = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`]?.trim();
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
async function run() {
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
        await client.shutdown();
        console.log(`IncidentIQ recorded deployment context for ${event.service}`);
    }
    catch (error) {
        console.warn(`IncidentIQ deployment context was not exported: ${error instanceof Error ? error.message : String(error)}`);
    }
}
void run();

