import test from "node:test";
import assert from "node:assert/strict";
import { AiExplanationService, validateAiExplanation } from "../src/ai-explanation.service.js";
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
