import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { defineConfig } from "drizzle-kit"

// drizzle-kit does not load .env itself, so load it here — every drizzle-kit
// command (generate / migrate / push / studio) then sees DATABASE_URL.
// `DRIZZLE_ENV_FILE` selects which file: `.env` locally (the default),
// `.env.prod` for prod pushes (see `db:push:prod`).
const explicitEnvFile = process.env.DRIZZLE_ENV_FILE
const envFile = explicitEnvFile ?? ".env"
if (existsSync(envFile)) {
  if (explicitEnvFile) {
    // An explicitly chosen file is AUTHORITATIVE. `process.loadEnvFile` (like
    // `--env-file`) refuses to overwrite a variable already in the environment,
    // so a shell-exported local DATABASE_URL would silently shadow .env.prod and
    // a "prod" push would land on the local DB. Parse and assign so the file wins.
    Object.assign(process.env, parseEnv(readFileSync(envFile, "utf8")))
  } else {
    process.loadEnvFile(envFile)
  }
}

// Read DATABASE_URL directly rather than via `./src/env.js`: a schema push needs
// only the connection string, and going through the app's env validator would
// demand unrelated prod secrets (BETTER_AUTH_SECRET, MEMORY_GRANT_SECRET, …) that
// drizzle-kit has no use for. The local default matches `env.ts`.
const databaseUrl =
  process.env.DATABASE_URL?.trim() || "postgres://postgres:postgres@localhost:5433/jingler"

// A misconfigured .env.prod (empty or local DATABASE_URL) must fail loudly rather
// than quietly push prod's schema onto the local database — the exact silent
// footgun DRIZZLE_ENV_FILE exists to avoid.
if (explicitEnvFile && /localhost|127\.0\.0\.1/.test(databaseUrl)) {
  throw new Error(
    `DRIZZLE_ENV_FILE=${explicitEnvFile} resolved DATABASE_URL to a local host — refusing to run. ` +
      "Set a real DATABASE_URL in that file."
  )
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true
})
