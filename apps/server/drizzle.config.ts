import { existsSync } from "node:fs"
import { defineConfig } from "drizzle-kit"
import { env } from "./src/env.js"

// drizzle-kit does not load .env itself, but the config below reads DATABASE_URL
// (and friends) from process.env via `./src/env.js`. Load the file here so every
// drizzle-kit command — generate / migrate / push / studio — sees it.
// `DRIZZLE_ENV_FILE` selects which: `.env` locally (the default), `.env.prod`
// for prod pushes (see `db:push:prod`).
const envFile = process.env.DRIZZLE_ENV_FILE ?? ".env"
if (existsSync(envFile)) process.loadEnvFile(envFile)

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: env.databaseUrl },
  strict: true,
  verbose: true
})
