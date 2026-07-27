/**
 * Apply generated SQL migrations (from ./drizzle) to the configured database.
 * Run with `pnpm --filter @jingler/server db:migrate` after `db:generate`.
 * Uses a dedicated single connection that is closed when done.
 */
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { env } from "../env.js"

const run = async (): Promise<void> => {
  const migrationClient = postgres(env.databaseUrl, { max: 1 })
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: "./drizzle" })
    // eslint-disable-next-line no-console
    console.log("[@jingler/server] migrations applied")
  } finally {
    await migrationClient.end()
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[@jingler/server] migration failed:", err)
  process.exit(1)
})
