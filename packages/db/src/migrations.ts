import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.js";

/**
 * Apply the committed SQL migrations in packages/db/migrations.
 * Idempotent — used by the migrate script, integration tests, and smoke runs.
 */
export async function applyMigrations(db: Db): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  await migrate(db, { migrationsFolder });
}
