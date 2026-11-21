import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { DatabaseService } from "./database.js";

export interface ApiKeyRecord {
  key_id: string;
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
      .select(["key_id", "tenant_id", "scope"])
      .where("key_hash", "=", hashApiKey(key))
      .where("revoked_at", "is", null)
      .where((expression) => expression.or([expression("expires_at", "is", null), expression("expires_at", ">", sql<string>`now()`)]))
      .executeTakeFirst();
  }

  async findActiveById(keyId: string): Promise<ApiKeyRecord | undefined> {
    return this.database.db
      .selectFrom("api_keys")
      .select(["key_id", "tenant_id", "scope"])
      .where("key_id", "=", keyId)
      .where("revoked_at", "is", null)
      .where((expression) => expression.or([expression("expires_at", "is", null), expression("expires_at", ">", sql<string>`now()`)]))
      .executeTakeFirst();
  }

  async create(
    scope: string,
    tenantId = "local",
    options: { label?: string; expiresAt?: string } = {}
  ): Promise<{ key: string; keyId: string; visiblePrefix: string }> {
    const key = `iiq_${randomBytes(24).toString("base64url")}`;
    const keyId = randomUUID();
    const visiblePrefix = key.slice(0, 12);
    await this.database.db
      .insertInto("api_keys")
      .values({
        key_id: keyId,
        key_hash: hashApiKey(key),
        visible_prefix: visiblePrefix,
        scope,
        tenant_id: tenantId,
        label: options.label ?? null,
        expires_at: options.expiresAt ?? null,
        revoked_at: null
      })
      .execute();
    return { key, keyId, visiblePrefix };
  }
}
