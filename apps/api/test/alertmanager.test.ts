import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAlertmanagerWebhook } from "../src/alertmanager.service.js";

const firingAlert = {
  version: "4",
  alerts: [{
    status: "firing",
    labels: {
      alertname: "HighLatency",
      severity: "critical",
      service: "orders",
      namespace: "payments",
      environment: "production",
      incidentiq_signal: "latency_spike"
    },
    annotations: { summary: "p95 latency is above one second" },
    startsAt: "2026-10-30T08:00:00.000Z",
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: "http://prometheus/graph?g0.expr=high_latency",
    fingerprint: "abc123"
  }]
};

test("normalizes Alertmanager firing alerts into idempotent evidence", () => {
  const [event] = normalizeAlertmanagerWebhook(firingAlert, "local", new Date("2026-10-30T08:01:00.000Z"));

  assert.equal(event?.source, "alertmanager");
  assert.equal(event?.event_type, "latency_spike");
  assert.equal(event?.severity, "critical");
  assert.equal(event?.resource, "service/payments/orders");
  assert.equal(event?.attributes.alert_status, "firing");
  assert.deepEqual(normalizeAlertmanagerWebhook(firingAlert, "local")[0]?.event_id, event?.event_id);
});

test("records resolved alerts separately and requires stable service labels", () => {
  const [resolved] = normalizeAlertmanagerWebhook({
    ...firingAlert,
    alerts: [{ ...firingAlert.alerts[0], status: "resolved", endsAt: "2026-10-30T08:05:00.000Z" }]
  }, "local");

  assert.equal(resolved?.severity, "info");
  assert.equal(resolved?.occurred_at, "2026-10-30T08:05:00.000Z");
  assert.notEqual(resolved?.event_id, normalizeAlertmanagerWebhook(firingAlert, "local")[0]?.event_id);
  assert.throws(() => normalizeAlertmanagerWebhook({ ...firingAlert, alerts: [{ ...firingAlert.alerts[0], labels: { ...firingAlert.alerts[0].labels, service: "" } }] }, "local"), /service/);
});
