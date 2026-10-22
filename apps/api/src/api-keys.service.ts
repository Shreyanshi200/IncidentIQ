import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "./database.js";

export interface ApiKeyRecord {
  tenant_id: string;
  scope: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly database: DatabaseService) {}

  async findActive(key: string): Promise<ApiKeyRecord | undefined> {
    return this.database.db
      .selectFrom("api_keys")
      .select(["tenant_id", "scope"])
      .where("key_hash", "=", hashApiKey(key))
      .where("revoked_at", "is", null)
      .executeTakeFirst();
  }

  async create(scope: string, tenantId = "local"): Promise<{ key: string; visiblePrefix: string }> {
    const key = `iiq_${randomBytes(24).toString("base64url")}`;
    const visiblePrefix = key.slice(0, 12);
    await this.database.db
      .insertInto("api_keys")
      .values({ key_id: randomUUID(), key_hash: hashApiKey(key), visible_prefix: visiblePrefix, scope, tenant_id: tenantId, revoked_at: null })
      .execute();
    return { key, visiblePrefix };
  }
}
