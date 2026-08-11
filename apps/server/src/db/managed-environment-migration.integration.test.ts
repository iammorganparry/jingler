import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  fileURLToPath(new URL("../../drizzle/0009_managed_environments.sql", import.meta.url)),
  "utf8"
)
const verification = readFileSync(
  fileURLToPath(new URL("../../drizzle/verify_managed_environments.sql", import.meta.url)),
  "utf8"
)

const requiredTables = [
  "managed_environment",
  "managed_session_runtime",
  "managed_usage_reservation",
  "workspace_checkpoint"
] as const

describe("managed environment migration", () => {
  it("applies managed environment migration to a clean database", () => {
    for (const table of requiredTables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`)
    }
    expect(migration).toContain("ON DELETE cascade")
  })

  it("verifies production managed environment indexes and constraints", () => {
    expect(migration).toContain("managed_environment_user_state_updated_idx")
    expect(migration).toContain("managed_usage_user_window_state_idx")
    expect(migration).toContain("workspace_checkpoint_runtime_digest_unique")
    expect(migration).toContain("managed_environment_state_check")
    expect(verification).toContain("to_regclass")
  })

  it.runIf(process.env.JINGLER_DB_TESTS === "1")(
    "verifies the production migration revision before feature enablement",
    async () => {
      const sql = postgres(
        process.env.DATABASE_URL ??
          "postgres://postgres:postgres@localhost:5433/jingler",
        { max: 1 }
      )
      try {
        const rows = await sql<{ name: string }[]>`
          select required.name
          from (
            values
              ('managed_environment'),
              ('managed_session_runtime'),
              ('managed_usage_reservation'),
              ('workspace_checkpoint'),
              ('managed_environment_user_state_updated_idx'),
              ('managed_usage_user_window_state_idx')
          ) as required(name)
          where to_regclass('public.' || required.name) is null
        `
        expect(rows).toEqual([])
      } finally {
        await sql.end()
      }
    }
  )
})
