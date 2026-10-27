import test from "node:test";
import assert from "node:assert/strict";
import { readCollectorConfig } from "../src/config.js";
import { createKubernetesSignals } from "../src/signals.js";

const config = readCollectorConfig({
  INCIDENTIQ_API_KEY: "iiq_test",
  INCIDENTIQ_ENVIRONMENT: "production",
  INCIDENTIQ_CLUSTER_NAME: "payments-cluster",
  INCIDENTIQ_KUBERNETES_NAMESPACE: "payments"
});

test("normalizes pod failures into deterministic workload signals", () => {
  const signals = createKubernetesSignals(config, [{
    metadata: {
      name: "orders-7f8d9",
      namespace: "payments",
      uid: "pod-1",
      labels: { "app.kubernetes.io/name": "orders" }
    },
    status: {
      containerStatuses: [{
        name: "api",
        restartCount: 3,
        state: { waiting: { reason: "CrashLoopBackOff", message: "Back-off restarting failed container" } },
        lastState: { terminated: { reason: "OOMKilled", finishedAt: "2026-10-27T02:00:00.000Z" } }
      }],
      conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "Insufficient memory", lastTransitionTime: "2026-10-27T01:59:00.000Z" }]
    }
  }], [], new Date("2026-10-27T02:01:00.000Z"));

  assert.deepEqual(signals.map((signal) => signal.event_type).sort(), ["crash_loop_back_off", "failed_scheduling", "oom_killed", "pod_restart"]);
  assert.equal(signals.every((signal) => signal.service === "orders" && signal.resource === "pod/payments/orders-7f8d9"), true);
  assert.equal(new Set(signals.map((signal) => signal.event_id)).size, signals.length);
});

test("maps warning Events to the owning labeled pod", () => {
  const signals = createKubernetesSignals(config, [{
    metadata: { name: "orders-7f8d9", namespace: "payments", uid: "pod-1", labels: { "app.kubernetes.io/name": "orders" } }
  }], [{
    metadata: { uid: "event-1", namespace: "payments" },
    involvedObject: { kind: "Pod", name: "orders-7f8d9", namespace: "payments" },
    reason: "Unhealthy",
    message: "Readiness probe failed",
    count: 2,
    eventTime: "2026-10-27T02:00:00.000Z"
  }], new Date("2026-10-27T02:01:00.000Z"));

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.event_type, "unhealthy");
  assert.equal(signals[0]?.severity, "warning");
  assert.equal(signals[0]?.attributes.message, "Readiness probe failed");
});

test("ignores unlabeled pods so service evidence stays stable", () => {
  const signals = createKubernetesSignals(config, [{
    metadata: { name: "orders-7f8d9", namespace: "payments", uid: "pod-1" },
    status: { containerStatuses: [{ name: "api", restartCount: 1 }] }
  }], []);

  assert.deepEqual(signals, []);
});
