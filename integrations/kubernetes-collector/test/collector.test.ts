import test from "node:test";
import assert from "node:assert/strict";
import { collectOnce, PendingPodEvents, startCheckpointedWatch } from "../src/collector.js";
import { readCollectorConfig } from "../src/config.js";

test("collects labeled pod evidence and reports failed delivery without throwing", async () => {
  const tracked: string[] = [];
  const result = await collectOnce({
    listPods: async () => ({
      items: [{
        metadata: { name: "orders-7f8d9", namespace: "payments", uid: "pod-1", labels: { "app.kubernetes.io/name": "orders" } },
        status: { containerStatuses: [{ name: "api", restartCount: 1 }] }
      }],
      resourceVersion: "100"
    }),
    listEvents: async () => ({ items: [], resourceVersion: "101" }),
    listDeployments: async () => ({ items: [], resourceVersion: "102" }),
    listJobs: async () => ({ items: [], resourceVersion: "103" }),
    watchPods: async () => ({ abort() {} }),
    watchEvents: async () => ({ abort() {} }),
    watchDeployments: async () => ({ abort() {} }),
    watchJobs: async () => ({ abort() {} })
  }, {
    track: (event) => tracked.push(event.event_type),
    flush: async () => false,
    shutdown: async () => true
  }, readCollectorConfig({
    INCIDENTIQ_API_KEY: "iiq_test",
    INCIDENTIQ_ENVIRONMENT: "production",
    INCIDENTIQ_CLUSTER_NAME: "payments-cluster",
    INCIDENTIQ_KUBERNETES_NAMESPACE: "payments"
  }), new Date("2026-10-27T02:00:00.000Z"));

  assert.deepEqual(tracked, ["pod_restart"]);
  assert.equal(result.collected, 1);
  assert.equal(result.delivered, false);
  assert.equal(result.podResourceVersion, "100");
  assert.equal(result.eventResourceVersion, "101");
  assert.equal(result.deploymentResourceVersion, "102");
  assert.equal(result.jobResourceVersion, "103");
});

test("reuses checkpoints and relists after an expired resource version", async () => {
  const checkpoints: string[] = [];
  const completions: Array<(error?: unknown) => void> = [];
  const lists: string[] = [];
  const watch = startCheckpointedWatch({
    list: async () => {
      lists.push("list");
      return { items: [{ value: "fresh" }], resourceVersion: "20" };
    },
    watch: async (resourceVersion, onEvent, onDone) => {
      checkpoints.push(resourceVersion);
      completions.push(onDone);
      onEvent("BOOKMARK", { value: "bookmark" }, resourceVersion === "10" ? "11" : "21");
      return { abort: () => onDone() };
    }
  }, {
    initialResourceVersion: "10",
    reconnectDelayMs: 1,
    onList: () => {},
    onEvent: () => {},
    onWarning: () => {}
  });

  await waitFor(() => checkpoints.length === 1);
  completions[0]?.(Object.assign(new Error("Gone"), { statusCode: 410 }));
  await waitFor(() => checkpoints.length === 2);
  assert.deepEqual(checkpoints, ["10", "20"]);
  assert.deepEqual(lists, ["list"]);

  watch.stop();
  await watch.done;
});

test("re-lists when a watch sends an expired checkpoint status event", async () => {
  const checkpoints: string[] = [];
  const completions: Array<(error?: unknown) => void> = [];
  const watch = startCheckpointedWatch<unknown>({
    list: async () => ({ items: [], resourceVersion: "20" }),
    watch: async (resourceVersion, onEvent, onDone) => {
      checkpoints.push(resourceVersion);
      completions.push(onDone);
      if (resourceVersion === "10") onEvent("ERROR", { code: 410 });
      return { abort: () => onDone() };
    }
  }, {
    initialResourceVersion: "10",
    reconnectDelayMs: 1,
    onList: () => {},
    onEvent: () => {},
    onWarning: () => {}
  });

  await waitFor(() => checkpoints.length === 1);
  completions[0]?.();
  await waitFor(() => checkpoints.length === 2);
  assert.deepEqual(checkpoints, ["10", "20"]);

  watch.stop();
  await watch.done;
});

test("retains an Event that arrives before its Pod and expires one that never resolves", () => {
  const pending = new PendingPodEvents(100);
  const event = {
    metadata: { uid: "event-1", namespace: "payments" },
    involvedObject: { kind: "Pod", name: "orders-7f8d9", namespace: "payments" },
    reason: "Unhealthy"
  };

  pending.add(event, 0);
  assert.deepEqual(pending.take({ metadata: { name: "orders-7f8d9", namespace: "payments" } }, 50), [event]);

  pending.add(event, 0);
  assert.deepEqual(pending.take({ metadata: { name: "orders-7f8d9", namespace: "payments" } }, 100), []);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met");
}
