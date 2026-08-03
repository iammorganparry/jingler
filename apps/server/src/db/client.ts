/**
 * Postgres client + Drizzle instance, created ONCE on first use. On Vercel the
 * function module is reused across warm invocations, so a cached client
 * (rather than one-per-request) avoids exhausting connections. `prepare: false`
 * keeps it compatible with a transaction-mode connection pooler (PgBouncer /
 * Supabase / Neon) in production; `postgres.js` connects lazily on first query,
 * so importing this never opens a socket.
 *
 * INTERNAL: `db` has exactly two sanctioned consumers — the `Database` Effect
 * service (`db/database.ts`), which every Repository goes through, and BetterAuth's
 * `drizzleAdapter` (`auth.ts`), which manages its own queries. App/route code must
 * NOT import `db` directly; use a Repository.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { env } from "../env.js"
import { schema } from "./schema.js"

const createClients = () => {
  const sql = postgres(env.databaseUrl, {
    max: env.isDev ? 10 : 1,
    prepare: false
  })
  return { sql, db: drizzle(sql, { schema }) }
}

let cachedClients: ReturnType<typeof createClients> | undefined
const clients = (): ReturnType<typeof createClients> =>
  (cachedClients ??= createClients())

export const getSql = (): ReturnType<typeof createClients>["sql"] => clients().sql
export const getDb = (): ReturnType<typeof createClients>["db"] => clients().db
