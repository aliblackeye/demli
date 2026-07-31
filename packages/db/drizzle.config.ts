import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config — used for `pnpm --filter @demli/db generate`.
 * Migrations are applied by src/migrate.ts (drizzle-orm migrator), not by kit,
 * so no database credentials are needed here.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
