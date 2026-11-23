import { DatabaseService } from "../src/database.js";

export async function clearTestTenants(database: DatabaseService, ...tenantIds: string[]): Promise<void> {
  await database.db.transaction().execute(async (transaction) => {
    await transaction.deleteFrom("clickhouse_archive_outbox").where("tenant_id", "in", tenantIds).execute();
    await transaction.deleteFrom("incidents").where("tenant_id", "in", tenantIds).execute();
    await transaction.deleteFrom("source_events").where("tenant_id", "in", tenantIds).execute();
    await transaction.deleteFrom("api_keys").where("tenant_id", "in", tenantIds).execute();
  });
}
