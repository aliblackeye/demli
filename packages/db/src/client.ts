import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export interface CreateDbOptions {
  /** Max pool connections (default 10; use 1 for migrations/scripts). */
  max?: number;
}

/** Typed client factory. The only way the apps obtain a database handle. */
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    onnotice: () => {
      /* silence NOTICE spam in dev */
    },
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

export type DbClient = ReturnType<typeof createDb>;
export type Db = DbClient["db"];
