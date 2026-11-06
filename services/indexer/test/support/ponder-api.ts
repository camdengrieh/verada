/**
 * Test stand-in for Ponder's virtual `ponder:api` module (aliased in vitest.config.ts). The real
 * module exports the read-only drizzle client of the running app; here the suite plugs in a client
 * over an embedded Postgres with {@link setDb}.
 */
// biome-ignore lint/suspicious/noExplicitAny: the drizzle client type depends on the driver in use
export let db: any;

// biome-ignore lint/suspicious/noExplicitAny: see above
export function setDb(next: any) {
  db = next;
}

export const publicClients = {};
