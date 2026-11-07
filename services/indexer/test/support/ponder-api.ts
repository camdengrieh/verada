/**
 * Test stand-in for Ponder's virtual `ponder:api` module (aliased in vitest.config.ts). The real
 * module exports the read-only drizzle client of the running app; here the suite plugs in a client
 * over an embedded Postgres with {@link setDb}.
 */
export let db: any;

export function setDb(next: any) {
  db = next;
}

export const publicClients = {};
