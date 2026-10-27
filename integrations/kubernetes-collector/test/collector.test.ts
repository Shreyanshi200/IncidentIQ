import test from "node:test";
import assert from "node:assert/strict";
import { collectOnce } from "../src/collector.js";
import { readCollectorConfig } from "../src/config.js";

test("collects labeled pod evidence and reports failed delivery without throwing", async () => {
  const tracked: string[] = [];
  const result = await collectOnce({
    listPods: async () => [{
      metadata: { name: "orders-7f8d9", namespace: "payments", uid: "pod-1", labels: { "app.kubernetes.io/name": "orders" } },
      status: { containerStatuses: [{ name: "api", restartCount: 1 }] }
    }],
    listEvents: async () => []
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
  assert.deepEqual(result, { collected: 1, delivered: false });
});
