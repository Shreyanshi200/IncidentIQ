import { Body, Controller, Get, Headers, Post } from "@nestjs/common";
import { sql } from "kysely";
import { DatabaseService } from "./database.js";
import { EventsService } from "./events.service.js";

@Controller("v1")
export class AppController {
  constructor(private readonly events: EventsService, private readonly database: DatabaseService) {}

  @Post("events/batch")
  ingest(@Headers("authorization") authorization: string | undefined, @Body() body: unknown): Promise<{ accepted: number; duplicates: number }> {
    return this.events.ingest(authorization, body);
  }

  @Get("health")
  async health(): Promise<{ status: "ok" }> {
    await sql`select 1`.execute(this.database.db);
    return { status: "ok" };
  }
}
