# @jingler/server

The Jingler auth backend — [BetterAuth](https://www.better-auth.com/) over
Postgres/Drizzle, served by [Hono](https://hono.dev/). Runs locally under
`@hono/node-server` and deploys to Vercel unchanged (`api/[[...route]].ts`).

The desktop app is gated behind a sign-in wall and authenticates against this
service with a bearer token held in the OS keychain. Sign-in methods: **GitHub
OAuth**, **Google OAuth**, and **email magic link**.

## Local development

Everything runs offline — no OAuth apps or email provider needed. Magic-link URLs
are printed to the server console.

```bash
# 1. Start Postgres (repo root)
docker compose up -d db            # postgres:16 on localhost:5433

# 2. Configure
cp apps/server/.env.example apps/server/.env

# 3. Create the auth tables
pnpm --filter @jingler/server db:migrate

# 4. Run the server
pnpm --filter @jingler/server dev # http://localhost:9100
```

Health check: `curl http://localhost:9100/health` → `{"status":"ok",…}`.
Team Memory readiness: `curl http://localhost:9100/api/memory/health`. It returns
`ok`, `degraded` (with HTTP 503), or `disabled` without exposing credentials.

Request a magic link (the link is logged to the server console):

```bash
curl -X POST http://localhost:9100/api/auth/sign-in/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","callbackURL":"http://localhost:9100/desktop/callback"}'
```

## The desktop bridge

OAuth and magic-link flows finish in the user's browser, where the session is a
cookie the desktop app can't read. The client sets `GET /desktop/callback` as its
`callbackURL`; that route reads the fresh session server-side and 302-redirects to
`jingler://auth/callback?token=<bearer>`, which the desktop stores in the OS
keychain. From then on it calls the API with `Authorization: Bearer <token>`.

## Database access — Repositories via an Effect service

All hand-written DB access goes through the Effect-TS stack, never inline in a
route:

```
Hono route → runtime.runPromise(...) → Repository (Effect.Service) → Database.run → Drizzle
```

- `db/database.ts` — the `Database` Effect service. `Database.run(op, query)` is the
  only sanctioned way to execute a Drizzle query; it tags failures as `DatabaseError`.
- `db/repositories/*.ts` — one `Effect.Service` per aggregate (e.g. `UserRepository`),
  depending on `Database`, exposing typed methods that return `Effect`s. Add a
  repository, `provideMerge` its `.Default` in `runtime.ts`, and it's available to
  every handler.
- `runtime.ts` — a single `ManagedRuntime` wiring `Database` + the repositories.

Example consumer: `GET /api/me` validates the bearer session (BetterAuth) then loads
the user via `UserRepository.findById`.

**The one exception** is BetterAuth's `drizzleAdapter`, which owns its own queries
internally and is handed the raw Drizzle client directly in `auth.ts`. That's library
machinery; everything we write uses a repository. Route/app code must not import
`db/client.ts` directly.

## Schema

Drizzle schema (`src/db/schema.ts`) is BetterAuth's core tables: `user`,
`session`, `account`, `verification`. Downstream paid-user tables (billing,
subscriptions) reference `user.id`.

```bash
pnpm --filter @jingler/server db:generate   # generate a migration from schema.ts
pnpm --filter @jingler/server db:migrate     # apply migrations
pnpm --filter @jingler/server db:studio      # drizzle-kit studio
```

The client uses `postgres.js` with `prepare:false` and a module-scoped instance,
so it is safe behind a transaction-mode pooler (Supabase/Neon/PgBouncer) on
serverless.

## Environment

See `.env.example`. Required in production:

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Managed Postgres, ideally via a pooler. |
| `BETTER_AUTH_SECRET` | Strong random value (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | Public URL of this service. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app. Callback: `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. Redirect: `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `RESEND_API_KEY` | Magic-link email. Omit in dev to log links to the console. |
| `MEMORY_ENABLED` | Paid-team Memory rollout/circuit-breaker. Set `false` to disable grants, MCP, and capture without deleting accepted Markdown. |
| `MEMORY_GRANT_SECRET` | Dedicated HMAC key for short-lived organization grants. Never reuse the auth or Worker secret. |
| `MEMORY_GRANT_AUDIENCE` / `MEMORY_GRANT_TTL_SECONDS` | MCP audience (`jingler-memory-mcp`) and organization-grant lifetime (default `3600`). |
| `MEMORY_WORKER_URL` | Private Cloudflare Memory Worker origin. |
| `MEMORY_WORKER_SERVICE_SECRET` | Rotating Next.js-to-Worker credential; must equal the Worker's `MEMORY_SERVICE_SECRET`. |
| `MEMORY_REQUEST_TIMEOUT_MS` | Bounded private-service timeout (default `5000`). |

A social provider is only enabled when both its id + secret are set, so dev works
with magic links alone.

Team Memory is gated twice: `MEMORY_ENABLED` is the global rollout/circuit
breaker, and on top of it `POST /api/memory/grant` issues a grant only for an
organization the caller belongs to that has an active paid plan — every other
organization gets `403` even when the feature is globally enabled. See the
[shared-memory operations guide](../../docs/shared-memory.md) for the Cloudflare
Worker bindings, turbopuffer vector layer, monitoring, export, rebuild, and
credential rotation (including the turbopuffer key).

Headless MCP clients use organization-scoped Personal Access Tokens. An
authenticated user creates one with `POST /api/memory/tokens`, lists hash-free
metadata with `GET /api/memory/tokens`, and revokes their own token with
`DELETE /api/memory/tokens/:id`. Plaintext `jmem_…` credentials are returned once;
only SHA-256 hashes are stored. Every MCP request re-checks token revocation,
expiry, exact organization, live membership, and paid-plan eligibility. See the
[team-memory setup guide](../../skills/jingler-team-memory/references/setup.md) for
request examples.

## Testing

```bash
pnpm --filter @jingler/server test              # unit — repositories vs a fake Database (CI-safe)
pnpm --filter @jingler/server test:integration  # HTTP e2e vs real Postgres (needs docker compose up -d db + db:migrate)
```

`test:integration` drives the full auth flow through Hono's `app.request` against
a real database: magic-link → session → bearer → `/api/me` → sign out. It's
excluded from `pnpm test` (and CI), which has no Postgres.

The desktop sign-in flow is covered by Playwright e2e in
`apps/desktop/e2e/auth.spec.ts` (`pnpm --filter @jingler/desktop e2e`), against an
offline fake auth backend.

## Deploying to Vercel

Set the project root to `apps/server`. `vercel.json` rewrites all traffic to the
`api/[[...route]].ts` catch-all, which adapts the Hono app via `hono/vercel` on
the **Node** runtime (Postgres/Drizzle need Node, not edge). Set the env vars
above in the Vercel project.

The Memory endpoint is a stateless Streamable HTTP POST endpoint for MCP
`2026-07-28`. It deliberately has no initialize exchange, GET/SSE transport,
session ID, cookie, or instance affinity. Deployments can therefore scale across
Vercel instances; workflow and proposal handles carry durable progress. Rotate
the Worker credential using the Worker's current/previous-secret overlap, then
rotate the grant secret separately. See [the shared-memory operations guide](../../docs/shared-memory.md)
for bindings, monitoring, export, rebuild, and recovery.
