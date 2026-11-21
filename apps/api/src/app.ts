import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { type NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./database.js";

function bodyLimit(): string {
  const raw = process.env.INCIDENTIQ_MAX_BODY_KB?.trim();
  const value = raw ? Number(raw) : 256;
  if (!Number.isInteger(value) || value < 16 || value > 1_024) throw new Error("INCIDENTIQ_MAX_BODY_KB must be an integer between 16 and 1024");
  return `${value}kb`;
}

export async function createApp(): Promise<NestExpressApplication> {
  loadEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  app.useBodyParser("json", { limit: bodyLimit() });
  app.useBodyParser("urlencoded", { limit: "16kb", extended: false });
  const express = app.getHttpAdapter().getInstance() as { disable(name: string): void; set(name: string, value: unknown): void };
  express.disable("x-powered-by");
  if (process.env.NODE_ENV === "production") express.set("trust proxy", 1);
  app.use((request: { method?: string; originalUrl?: string; headers?: Record<string, string | string[] | undefined> }, response: { setHeader(name: string, value: string): void; statusCode?: number; once?(event: string, listener: () => void): void }, next: () => void) => {
    const suppliedId = request.headers?.["x-request-id"];
    const requestId = typeof suppliedId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(suppliedId) ? suppliedId : randomUUID();
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    const startedAt = Date.now();
    if (process.env.NODE_ENV === "production") {
      response.once?.("finish", () => console.log(JSON.stringify({
        level: "info",
        message: "http_request",
        request_id: requestId,
        method: request.method,
        path: request.originalUrl?.split("?")[0],
        status: response.statusCode,
        duration_ms: Date.now() - startedAt
      })));
    }
    next();
  });
  return app;
}
