import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service.js";

export const DASHBOARD_SESSION_COOKIE = "incidentiq_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  key_id: string;
  tenant_id: string;
  expires_at: number;
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function cookieValue(cookie: string | undefined, name: string): string | undefined {
  return cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

@Injectable()
export class DashboardSessionService {
  private readonly secret: Buffer;
  private readonly attempts = new Map<string, number[]>();
  private readonly attemptsPerMinute: number;

  constructor(private readonly apiKeys: ApiKeysService) {
    const configured = process.env.INCIDENTIQ_SESSION_SECRET;
    if (process.env.NODE_ENV === "production" && !configured) throw new Error("INCIDENTIQ_SESSION_SECRET is required when NODE_ENV=production");
    if (configured && Buffer.byteLength(configured) < 32) throw new Error("INCIDENTIQ_SESSION_SECRET must contain at least 32 bytes");
    this.secret = configured ? Buffer.from(configured) : randomBytes(32);
    const configuredAttempts = Number(process.env.INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE ?? 20);
    if (!Number.isInteger(configuredAttempts) || configuredAttempts < 1 || configuredAttempts > 1_000) {
      throw new Error("INCIDENTIQ_SESSION_ATTEMPTS_PER_MINUTE must be an integer between 1 and 1000");
    }
    this.attemptsPerMinute = configuredAttempts;
  }

  async create(authorization: string | undefined, clientId = "unknown"): Promise<{ token: string; expires_at: string }> {
    this.consumeAttempt(clientId);
    const key = bearerToken(authorization);
    const apiKey = key ? await this.apiKeys.findActive(key) : undefined;
    if (!apiKey || apiKey.scope !== "read") throw new UnauthorizedException("A valid read API key is required");
    const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS;
    const body = Buffer.from(JSON.stringify({ key_id: apiKey.key_id, tenant_id: apiKey.tenant_id, expires_at: expiresAt } satisfies SessionPayload)).toString("base64url");
    return { token: `${body}.${this.sign(body)}`, expires_at: new Date(expiresAt * 1_000).toISOString() };
  }

  async tenantId(cookie: string | undefined): Promise<string> {
    const token = cookieValue(cookie, DASHBOARD_SESSION_COOKIE);
    const [body, signature, extra] = token?.split(".") ?? [];
    if (!body || !signature || extra || !this.validSignature(body, signature)) throw new UnauthorizedException("A valid dashboard session is required");

    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      throw new UnauthorizedException("A valid dashboard session is required");
    }
    if (!payload.key_id || !payload.tenant_id || !Number.isInteger(payload.expires_at) || payload.expires_at <= Math.floor(Date.now() / 1_000)) {
      throw new UnauthorizedException("Dashboard session expired");
    }

    const apiKey = await this.apiKeys.findActiveById(payload.key_id);
    if (!apiKey || apiKey.scope !== "read" || apiKey.tenant_id !== payload.tenant_id) throw new UnauthorizedException("Dashboard session is no longer active");
    return payload.tenant_id;
  }

  cookie(token: string, secure: boolean): string {
    return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/v1/dashboard; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean): string {
    return `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/v1/dashboard; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private consumeAttempt(clientId: string): void {
    const now = Date.now();
    if (!this.attempts.has(clientId) && this.attempts.size >= 10_000) {
      for (const [id, timestamps] of this.attempts) {
        if (!timestamps.some((timestamp) => timestamp > now - 60_000)) this.attempts.delete(id);
      }
      if (this.attempts.size >= 10_000) throw new HttpException("Dashboard session capacity is temporarily exhausted", HttpStatus.TOO_MANY_REQUESTS);
    }
    const recent = (this.attempts.get(clientId) ?? []).filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= this.attemptsPerMinute) {
      this.attempts.set(clientId, recent);
      throw new HttpException("Too many dashboard session attempts; retry after one minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.attempts.set(clientId, recent);
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }

  private validSignature(body: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(body));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }
}
