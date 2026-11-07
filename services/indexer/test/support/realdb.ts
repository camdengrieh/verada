import * as rawSchema from "ponder:schema";
import { setDb } from "./ponder-api";

/**
 * A real Postgres engine for the SQL tests: PGlite (the same embedded Postgres Ponder uses for
 * `ponder dev`), with the tables created from `ponder.schema.ts` by Ponder's own DDL generator
 * (`getSql`, the code behind `CREATE TABLE` at startup) inside a dedicated schema, as Ponder does.
 *
 * `openRealDb()` resolves to null when the engine or Ponder's generator cannot be loaded, so the
 * suites that need it can skip instead of failing on a machine without the optional pieces.
 */
export interface RealDb {
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** The drizzle client, also installed as `db` of the `ponder:api` stand-in. */
  db: any;
}

interface PgPool {
  query(q: string): Promise<unknown>;
  on(ev: string, fn: (c: never) => void): void;
  end(): Promise<void>;
}

export const TEST_SCHEMA = "indexer_test";

export async function openRealDb(): Promise<RealDb | null> {
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    // Not in Ponder's public exports, so reached by path (the package is a direct dependency).
    const kitUrl = new URL("../../node_modules/ponder/dist/esm/drizzle/kit/index.js", import.meta.url).href;
    const kit = (await import(/* @vite-ignore */ kitUrl)) as {
      getSql: (schema: Record<string, unknown>) => {
        tables: { sql: string[]; json: { tableName: string }[] };
        indexes: { sql: string[] };
        enums: { sql: string[] };
      };
    };
    const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
    const ddl = kit.getSql(schema);

    // Optional second engine: set INDEXER_TEST_DATABASE_URL to run the same suite on a server
    // Postgres through node-postgres (what `ponder start` uses), e.g. a throwaway local cluster.
    const url = process.env.INDEXER_TEST_DATABASE_URL;
    const lite = url ? null : new PGlite();
    const pool = url ? new ((await import(/* @vite-ignore */ "pg" as string)) as { Pool: new (o: object) => PgPool }).Pool({ connectionString: url }) : null;
    pool?.on("connect", (c: { query(q: string): void }) => c.query(`SET search_path TO "${TEST_SCHEMA}", public`));
    const exec = async (sql: string) => {
      if (pool) await pool.query(sql);
      else await lite!.exec(sql);
    };
    await exec(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE; CREATE SCHEMA "${TEST_SCHEMA}"; SET search_path TO "${TEST_SCHEMA}", public;`);
    // Ponder pairs every table with a `_reorg__` shadow table fed by triggers; reads never touch them.
    const tables = ddl.tables.sql.filter((_, i) => !ddl.tables.json[i]!.tableName.startsWith("_reorg__"));
    for (const s of [...ddl.enums.sql, ...tables, ...ddl.indexes.sql]) await exec(s);
    let db: unknown;
    if (pool) {
      const { drizzle: nodePg } = await import("drizzle-orm/node-postgres");
      db = nodePg(pool as never);
    } else {
      db = drizzle(lite!);
    }
    setDb(db);
    return {
      db,
      exec,
      close: async () => {
        if (pool) await pool.end();
        else await lite!.close();
      },
    };
  } catch (e) {
    console.warn(`real-engine SQL tests skipped: ${(e as Error).message}`);
    return null;
  }
}
