import test from "node:test";
import assert from "node:assert/strict";
import { AiExplanationService, aiSettings, validateAiExplanation } from "../src/ai-explanation.service.js";
import type { DashboardIncidentDetail } from "../src/dashboard.service.js";

const incident: DashboardIncidentDetail = {
  incident_id: "incident-1",
  service: "checkout-api",
  environment: "production",
  state: "open",
  started_at: "2026-11-19T10:00:00.000Z",
  last_event_at: "2026-11-19T10:02:00.000Z",
  event_count: 2,
  leading_cause: "bad_release",
  confidence: "high",
  brief: {
    headline: "The release is linked to a route-specific failure",
    summary: "Version 3.4.0 was followed by a checkout error.",
    observed_scope: "Two linked events.",
    supporting_evidence: [],
    counterevidence: [],
    candidates: [{ cause: "bad_release", score: 10 }]
  },
  timeline: [
    {
      event_id: "deploy-1",
      occurred_at: "2026-11-19T10:00:00.000Z",
      service: "checkout-api",
      environment: "production",
      source: "github_actions",
      event_type: "deployment",
      severity: "info",
      version: "3.4.0",
      attributes: { commit_sha: "abc123" }
    },
    {
      event_id: "error-1",
      occurred_at: "2026-11-19T10:02:00.000Z",
      service: "checkout-api",
      environment: "production",
      source: "node_sdk",
      event_type: "exception",
      severity: "error",
      version: "3.4.0",
      attributes: { route: "POST /checkout" }
    }
  ],
  next_checks: ["Compare version 3.4.0 with the previous release."],
  ai_available: true
};

const modelOutput = {
  summary: "The recorded sequence supports a release-related checkout regression.",
  likely_cause: "Version 3.4.0 introduced a route-specific regression.",
  confidence_basis: "The deployment and first error share the same version and occurred two minutes apart.",
  evidence: [{ claim: "The error followed the deployment.", evidence_ids: ["deploy-1", "error-1"] }],
  next_checks: [{ action: "Compare the checkout change in version 3.4.0.", reason: "The first linked failure occurred after that release.", evidence_ids: ["deploy-1", "error-1"] }],
  limitations: ["No pre-release error-rate baseline is present."]
};

test("AI explanation validation rejects citations outside the incident timeline", () => {
  assert.equal(validateAiExplanation(modelOutput, new Set(["deploy-1", "error-1"]), "test-model")?.evidence.length, 1);
  assert.equal(validateAiExplanation({ ...modelOutput, evidence: [{ claim: "Unknown evidence.", evidence_ids: ["other-tenant-event"] }] }, new Set(["deploy-1", "error-1"]), "test-model"), undefined);
});

test("AI configuration requires the key and model together", () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.INCIDENTIQ_AI_MODEL;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.INCIDENTIQ_AI_MODEL;
  try {
    assert.throws(() => new AiExplanationService(), /must be configured together/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.INCIDENTIQ_AI_MODEL; else process.env.INCIDENTIQ_AI_MODEL = previousModel;
  }
});

test("AI explanations use structured, non-stored responses and return only validated citations", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.INCIDENTIQ_AI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.INCIDENTIQ_AI_MODEL = "test-model";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(modelOutput) }] }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const explanation = await new AiExplanationService().generate(incident);
    assert.equal(explanation.model, "test-model");
    assert.deepEqual(explanation.evidence[0]?.evidence_ids, ["deploy-1", "error-1"]);
    assert.equal(requestBody?.store, false);
    assert.equal(requestBody?.max_output_tokens, 8_000);
    assert.deepEqual(requestBody?.reasoning, { effort: "low" });
    assert.equal((requestBody?.text as { format?: { type?: string } }).format?.type, "json_schema");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.INCIDENTIQ_AI_MODEL; else process.env.INCIDENTIQ_AI_MODEL = previousModel;
  }
});

test("AI explanations report actionable provider and incomplete-response failures", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.INCIDENTIQ_AI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.INCIDENTIQ_AI_MODEL = "test-model";

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "project_spend_limit_exceeded" } }), { status: 429 });
    await assert.rejects(() => new AiExplanationService().generate(incident), /quota or project spend limit/i);

    globalThis.fetch = async () => new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), { status: 200 });
    await assert.rejects(() => new AiExplanationService().generate(incident), /output budget/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.INCIDENTIQ_AI_MODEL; else process.env.INCIDENTIQ_AI_MODEL = previousModel;
  }
});

test("AI explanation limits are configurable, bounded, and tenant scoped", async () => {
  const names = ["OPENAI_API_KEY", "INCIDENTIQ_AI_MODEL", "INCIDENTIQ_AI_TIMEOUT_SECONDS", "INCIDENTIQ_AI_MAX_OUTPUT_TOKENS", "INCIDENTIQ_AI_MAX_INPUT_KB", "INCIDENTIQ_AI_REQUESTS_PER_HOUR", "INCIDENTIQ_AI_MAX_TIMELINE_EVENTS", "INCIDENTIQ_AI_REASONING_EFFORT"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.INCIDENTIQ_AI_MODEL = "test-model";
  process.env.INCIDENTIQ_AI_TIMEOUT_SECONDS = "15";
  process.env.INCIDENTIQ_AI_MAX_OUTPUT_TOKENS = "2000";
  process.env.INCIDENTIQ_AI_MAX_INPUT_KB = "64";
  process.env.INCIDENTIQ_AI_REQUESTS_PER_HOUR = "1";
  process.env.INCIDENTIQ_AI_MAX_TIMELINE_EVENTS = "10";
  process.env.INCIDENTIQ_AI_REASONING_EFFORT = "medium";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(modelOutput) }] }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const service = new AiExplanationService();
    await service.generate(incident, "tenant-a");
    assert.equal(requestBody?.max_output_tokens, 2_000);
    assert.deepEqual(requestBody?.reasoning, { effort: "medium" });
    await assert.rejects(() => service.generate(incident, "tenant-a"), /hourly window/i);
    await service.generate(incident, "tenant-b");

    const oversized = { ...incident, timeline: Array.from({ length: 11 }, (_, index) => ({ ...incident.timeline[0]!, event_id: `event-${index}` })) };
    await assert.rejects(() => new AiExplanationService().generate(oversized, "tenant-c"), /configured AI limit is 10/i);
    const oversizedInput = {
      ...incident,
      timeline: Array.from({ length: 10 }, (_, index) => ({ ...incident.timeline[0]!, event_id: `large-event-${index}`, attributes: { message: "x".repeat(8_000) } }))
    };
    await assert.rejects(() => new AiExplanationService().generate(oversizedInput, "tenant-d"), /configured limit is 64 KiB/i);
    process.env.INCIDENTIQ_AI_TIMEOUT_SECONDS = "2";
    assert.throws(() => aiSettings(), /between 5 and 120/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
