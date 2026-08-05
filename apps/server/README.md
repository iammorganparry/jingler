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
pnpm --filter @jingler/server db:migrate     # apply generated migrations (local)
pnpm --filter @jingler/server db:push        # push schema straight to the DB, no migration file
pnpm --filter @jingler/server db:push:prod   # push to prod (loads .env.prod)
pnpm --filter @jingler/server db:studio      # drizzle-kit studio
```

All of these are drizzle-kit's own commands. drizzle-kit doesn't read `.env`
itself, so `drizzle.config.ts` loads it (`.env` by default, `.env.prod` when
`DRIZZLE_ENV_FILE` points at it — that's all `db:push:prod` sets). Prod schema
changes go out via `db:push`, not a migration file.

The client uses `postgres.js` with `prepare:false` and a module-scoped instance,
so it is safe behind a transaction-mode pooler (Supabase/Neon/PgBouncer) on
serverless.

## Environment

See `.env.example`. Core production variables and optional integration variables:

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Managed Postgres, ideally via a pooler. |
| `BETTER_AUTH_SECRET` | Strong random value (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | Public URL of this service; production is `https://api.jingler.dev`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional GitHub **social sign-in OAuth App**. Callback: `<BETTER_AUTH_URL>/api/auth/callback/github`. These are not the Jingler GitHub App credentials below. |
| `GITHUB_APP_ENABLED` | Enables the product GitHub integration. Production fails closed if this is `true` and any required GitHub App variable is absent. |
| `GITHUB_APP_ID` | Numeric ID shown in the GitHub App's General settings. |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | GitHub App user-authorization credentials. Keep the secret in the deployment secret store. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key PEM. In Vercel, store it on one line with literal `\\n` escapes. |
| `GITHUB_APP_WEBHOOK_SECRET` | The shared App webhook secret. Use the same value for the relay's `GITHUB_WEBHOOK_SECRET`; the relay performs signature verification. |
| `GITHUB_APP_RELAY_URL` | Relay origin; production is `https://github-relay.jingler.dev`. |
| `GITHUB_APP_RELAY_SIGNING_SECRET` | HMAC key for short-lived relay grants. Must equal the Worker's `GITHUB_RELAY_SIGNING_SECRET`; do not reuse an auth or webhook secret. |
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

## GitHub App registration

Register one shared, public GitHub App. GitHub social sign-in is optional and
remains a separate OAuth App; installing the product App must not create or reuse
a BetterAuth account record.

Use these production fields:

| GitHub field | Value |
|---|---|
| GitHub App name | `Jingler` (or the available production display name) |
| Homepage URL | `https://jingler.dev` |
| User authorization callback URL | `https://api.jingler.dev/api/github/callback` |
| Setup URL | `https://api.jingler.dev/api/github/setup` |
| Redirect on update | Enabled |
| Webhook URL | `https://github-relay.jingler.dev/webhooks/github` |
| Webhook content type | `application/json` |
| Webhook active | Enabled |
| Request user authorization during installation | Enabled |
| Expire user authorization tokens | Enabled |
| Where can this GitHub App be installed? | Any account |

Configure only these repository permissions:

| Repository permission | Access |
|---|---|
| Checks | Read-only |
| Commit statuses | Read-only |
| Contents | Read and write |
| Issues | Read and write |
| Metadata | Read-only (GitHub adds this automatically) |
| Pull requests | Read and write |
| Workflows | Read and write |

Leave Actions, Administration, Members, Secrets, and all organization/account
permissions at **No access**. Subscribe to these webhook events:

- Check run
- Check suite
- Installation
- Installation repositories
- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Status

After saving, copy the App ID and client ID, generate a client secret, generate a
private key, and generate a high-entropy webhook secret. Never place client
secrets, private keys, webhook secrets, or relay signing secrets in source,
examples, logs, screenshots, or support messages. If one is disclosed, revoke it
and replace it in every environment before continuing.

For local App testing, replace `https://api.jingler.dev` above with
`http://localhost:9100`. The local relay runs on `http://localhost:9200`; expose
it using the cloudflared flow in
[the relay guide](../github-relay/README.md#local-development) and temporarily
use that tunnel's `/webhooks/github` URL in the development App.

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

For production, attach `api.jingler.dev` to the Vercel project and set
`BETTER_AUTH_URL=https://api.jingler.dev`,
`GITHUB_APP_RELAY_URL=https://github-relay.jingler.dev`, and
`GITHUB_APP_ENABLED=true`. Add every `GITHUB_APP_*` value as a Vercel encrypted
environment variable for Production (and Preview only when a preview App and
callback are deliberately configured). Redeploy after changing environment
variables. The desktop build targets the same server with
`JINGLER_AUTH_URL=https://api.jingler.dev`.

The server mints GitHub installation credentials only after authenticating the
Jingler user, reconciling installation ownership, and rejecting suspended or
cross-user installations. Installation credentials are short-lived and must not
be persisted, logged, forwarded to the renderer, or exposed to agents. The
credential response is `Cache-Control: no-store`.

### Rotation and rollback

Rotate one credential class at a time and verify `/health`, GitHub connection
status, and a non-destructive repository read after each change:

1. Add a new GitHub App client secret, update Vercel, redeploy, then delete the
   old client secret in GitHub.
2. Generate a new App private key, update Vercel, verify token minting, then
   delete the old key in GitHub.
3. Update the GitHub App and relay Worker with a new webhook secret together,
   then redeliver a recent webhook from GitHub.
4. Update the server and relay signing secret together. Existing five-minute
   relay grants may reconnect only after the desktop refreshes them.

Monitor failed installation reconciliation, credential-mint failures, GitHub
rate-limit/validation responses, and relay-grant failures without logging tokens
or request authorization headers. To roll back, restore the previous Vercel
deployment and compatible secrets. Set `GITHUB_APP_ENABLED=false` as the product
integration circuit breaker; this disables new GitHub operations without
deleting installation ownership records.

The Memory endpoint is a stateless Streamable HTTP POST endpoint for MCP
`2026-07-28`. It deliberately has no initialize exchange, GET/SSE transport,
session ID, cookie, or instance affinity. Deployments can therefore scale across
Vercel instances; workflow and proposal handles carry durable progress. Rotate
the Worker credential using the Worker's current/previous-secret overlap, then
rotate the grant secret separately. See [the shared-memory operations guide](../../docs/shared-memory.md)
for bindings, monitoring, export, rebuild, and recovery.
