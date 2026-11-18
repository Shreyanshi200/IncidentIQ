import { Controller, Delete, Get, Headers, Post, Res } from "@nestjs/common";
import { DashboardSessionService } from "./dashboard-session.service.js";
import { type DashboardOverview, DashboardService } from "./dashboard.service.js";

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

function usesHttps(forwardedProtocol: string | undefined): boolean {
  return forwardedProtocol?.split(",")[0]?.trim() === "https";
}

@Controller("v1/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService, private readonly sessions: DashboardSessionService) {}

  @Post("session")
  async createSession(
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-forwarded-proto") forwardedProtocol: string | undefined,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<{ expires_at: string }> {
    const session = await this.sessions.create(authorization);
    response.setHeader("set-cookie", this.sessions.cookie(session.token, usesHttps(forwardedProtocol)));
    return { expires_at: session.expires_at };
  }

  @Delete("session")
  clearSession(
    @Headers("x-forwarded-proto") forwardedProtocol: string | undefined,
    @Res({ passthrough: true }) response: HeaderResponse
  ): { cleared: true } {
    response.setHeader("set-cookie", this.sessions.clearCookie(usesHttps(forwardedProtocol)));
    return { cleared: true };
  }

  @Get("overview")
  overview(@Headers("cookie") cookie: string | undefined): Promise<DashboardOverview> {
    return this.dashboard.overview(cookie);
  }
}
