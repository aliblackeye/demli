/**
 * Applies committed SQL migrations from ./migrations to DATABASE_URL.
 * Run via: pnpm db:migrate (root) or pnpm --filter @demli/db migrate.
 */

import { createDb } from "./client.js";
import { applyMigrations } from "./migrations.js";

const connectionString =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

const { db, close } = createDb(connectionString, { max: 1 });

try {
  await applyMigrations(db);
  console.log("[db] migrations applied");
} catch (err) {
  console.error("[db] migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
