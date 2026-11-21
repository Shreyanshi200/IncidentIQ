import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { DashboardSessionService } from "../src/dashboard-session.service.js";

test("dashboard session attempts are rate limited per client", async () => {
  const previous = process.env.INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE;
  process.env.INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE = "1";
  const apiKeys = { findActive: async () => undefined };
  try {
    const sessions = new DashboardSessionService(apiKeys as never);
    await assert.rejects(() => sessions.create(undefined, "client-a"), /valid read API key/i);
    await assert.rejects(() => sessions.create(undefined, "client-a"), /too many dashboard session attempts/i);
    await assert.rejects(() => sessions.create(undefined, "client-b"), /valid read API key/i);
  } finally {
    if (previous === undefined) delete process.env.INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE; else process.env.INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE = previous;
  }
});

test("production requires a stable dashboard session secret", () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousSecret = process.env.INCIDENTIQ_SESSION_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.INCIDENTIQ_SESSION_SECRET;
  try {
    assert.throws(() => new DashboardSessionService({} as never), /INCIDENTIQ_SESSION_SECRET is required/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.INCIDENTIQ_SESSION_SECRET; else process.env.INCIDENTIQ_SESSION_SECRET = previousSecret;
  }
});

test("production trusts exactly one reverse proxy hop for per-client limits", async () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousSecret = process.env.INCIDENTIQ_SESSION_SECRET;
  process.env.NODE_ENV = "production";
  process.env.INCIDENTIQ_SESSION_SECRET = "x".repeat(48);
  const app = await createApp();
  try {
    const express = app.getHttpAdapter().getInstance() as { get(name: string): unknown };
    assert.equal(express.get("trust proxy"), 1);
  } finally {
    await app.close();
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.INCIDENTIQ_SESSION_SECRET; else process.env.INCIDENTIQ_SESSION_SECRET = previousSecret;
  }
});
