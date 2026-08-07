# Jingler

Jingler is a desktop workspace for running coding agents across multiple repositories. Each
session gets its own git branch and isolated worktree, so agents can plan, edit, test, and open
pull requests without colliding with one another.

It is an Electron application backed by a small local authentication service. Jingler discovers
the coding CLIs already installed on your machine and keeps its desktop state in `~/jingler`.

## What you can do

- Run Claude Code, Codex CLI, Cursor Agent, or OpenCode sessions from one desktop app.
- Work on several tasks in parallel, each in an isolated git worktree.
- Review plans, diffs, agent activity, and pull requests without leaving the session.
- Start work from a new branch, an existing GitHub pull request, or a GitHub issue.
- Use built-in terminals, browser previews, themes, MCP servers, and agent skills.
- Give paid teams a cited, agent-managed shared Memory wiki with private lexical search, analytics, and an explicit-evidence mind map.

## Requirements

- macOS, Windows, or Linux
- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 10.7.0
- [Docker](https://www.docker.com/) for the local PostgreSQL auth database
- Git and at least one supported coding CLI, already installed and signed in

Pull-request and issue features use the Jingler GitHub App. Connect it during
onboarding or from **Settings → GitHub**; the GitHub CLI is not required.

Jingler currently requires Codex CLI 0.144 or newer and OpenCode 1.18 or newer. The app reports
an upgrade command if it finds an older version.

## Run Jingler from source

1. Clone the repository and install dependencies.

   ```bash
   git clone https://github.com/iammorganparry/jingler.git
   cd jingler
   pnpm install
   ```

2. Create the local server configuration.

   ```bash
   cp apps/server/.env.example apps/server/.env
   ```

   The example configuration is ready for local development. It uses a development-only auth
   secret, the Docker database, and prints magic-link URLs to the terminal instead of sending
   email.

3. Start PostgreSQL and apply the database migrations.

   ```bash
   docker compose up -d db
   pnpm --filter @jingler/server db:migrate
   ```

4. Start the auth server and desktop app.

   ```bash
   pnpm dev
   ```

   The server listens on `http://localhost:9100`, and Electron opens the Jingler window.

5. Sign in with an email address.

   In local development, copy the magic-link URL printed by the server process and open it in
   your browser. The browser redirects back to the desktop app through the `jingler://` protocol.

## First session

1. On the welcome screen, choose the parent folder that contains your git repositories, such as
   `~/repos`. Jingler scans for repositories up to three directories deep.

2. Open **New session** or press <kbd>⌘</kbd><kbd>N</kbd>, then select a repository and base
   branch. The default coding CLI is configured under **Settings → Providers**.

3. Create the session. A fresh worktree starts detached at the latest available
   `origin/<base>` (or the safe local base while offline) under
   `~/jingler/worktrees`. After the first task-understanding turn, Jingler
   validates the agent's metadata and creates a conventional `type/kebab-slug`
   branch itself.

4. Describe the task in the composer. Use the plan controls when you want a reviewable plan before
   implementation, and inspect file changes from the session's changes view.

5. If the Jingler GitHub App is connected, create or link a pull request from the PR view.
   Sessions can also be created directly from open pull requests or issues.

## Common commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start every app in development mode |
| `pnpm build` | Build the desktop app and workspace packages |
| `pnpm lint` | Run Biome lint checks |
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Run the Vitest test suite |

Useful focused commands:

```bash
pnpm --filter @jingler/desktop dev
pnpm --filter @jingler/server dev
pnpm --filter @jingler/server test:integration
pnpm --filter @jingler/desktop e2e
pnpm --filter @jingler/desktop electron:pack
```

The integration tests require the Docker database and applied migrations. The Electron
Playwright suite runs locally and is not part of CI.

## Configuration and data

The desktop stores configuration, sessions, transcripts, themes, worktrees, and encrypted auth
state under `~/jingler`. Set `JINGLER_HOME` before starting the app to use another location.

The desktop connects to `http://localhost:9100` by default. Set `JINGLER_AUTH_URL` to point it at
another auth service.

Server configuration lives in `apps/server/.env`. The local defaults need no third-party
credentials. Production deployments require `DATABASE_URL`, `BETTER_AUTH_SECRET`, and
`BETTER_AUTH_URL`; GitHub, Google, and Resend credentials enable their corresponding sign-in
methods. See [apps/server/README.md](apps/server/README.md) for the complete server and deployment
guide.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main process, preload bridge, React renderer, and end-to-end tests |
| `apps/server` | Hono, Better Auth, PostgreSQL/Drizzle, and email templates |
| `apps/github-relay` | Cloudflare Worker that verifies GitHub webhooks and streams resumable review events |
| `apps/memory-worker` | Organization-isolated Cloudflare vault, workflows, search, graph, and analytics |
| `packages/memory` | Deterministic Markdown, revision, graph, analytics, export, and linting contracts |
| `packages/core` | Shared domain models, schemas, and orchestration logic |
| `packages/cli-adapters` | Coding-agent, git, GitHub, terminal, session, and workspace services |
| `packages/ui` | Shared React components, screens, styles, and themes |

The monorepo uses Turborepo and pnpm workspaces. Shared packages export TypeScript source directly,
so development changes are picked up without a separate package build.

Shared Memory deployment and recovery are documented in
[docs/shared-memory.md](docs/shared-memory.md); Worker binding details live in
[apps/memory-worker/README.md](apps/memory-worker/README.md).

GitHub App registration, Vercel configuration, and credential rotation are
documented in [apps/server/README.md](apps/server/README.md#github-app-registration).
Webhook relay deployment, replay, and incident recovery are documented in
[apps/github-relay/README.md](apps/github-relay/README.md).

## Continuous deployment

Every successful `CI` run for a push to `main` deploys the exact tested commit
to both Cloudflare Workers through
[`.github/workflows/deploy-workers.yml`](.github/workflows/deploy-workers.yml).
Failed or pull-request CI runs never deploy, and production deploys are
serialized so a newer merge cannot cancel a Worker migration already in flight.

Configure these GitHub Actions repository secrets before merging a Worker
change:

- `CLOUDFLARE_API_TOKEN` — a least-privilege token scoped to this account with
  permission to edit the deployed Workers and their declared resources.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account that owns both Workers.

Worker runtime secrets remain managed separately with `wrangler secret put`;
the deployment workflow neither creates nor rotates them. Manual deployment and
recovery instructions live in each Worker's README.

## GitHub and branch migration

GitHub social sign-in and the product GitHub App are separate connections. An
existing `config.json` remains valid when it has no GitHub section: open
**Settings → GitHub** once, reconnect the App, and enable pull-request features
if they were previously disabled. Saving those preferences preserves every
unrelated workspace setting.

Fresh isolated task sessions use semantic branches with one of `feat`, `fix`,
`refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`, `style`, or `revert`.
Jingler normalizes and validates the complete ref, resolves collisions, and owns
the git mutation; model output is never executed. Direct sessions keep the
developer's checked-out branch, sessions opened from a PR keep its head ref,
and established historical sessions — including persisted `jingler/*` branches
from older releases — remain publishable without automatic rename.

Built-in GitHub reads, writes, checkout, authenticated push, plugin grants, and
realtime feedback use the shared GitHub App. Installation credentials live only
in the Electron main process and are never persisted or returned to the
renderer. A clean machine needs `git`, not the GitHub CLI.

## Troubleshooting

**No repositories appear**

Choose the directory that contains your repositories, not an individual repository. Jingler
stops scanning after three nested directory levels and ignores build and dependency directories.

**No coding CLI is available**

Install and authenticate Claude Code, Codex CLI, Cursor Agent, or OpenCode, then reopen the new
session dialog. GUI applications can have a limited `PATH`; Jingler also checks common install
locations such as `~/.local/bin` and `/opt/homebrew/bin`.

**Sign-in email does not arrive in local development**

This is expected when `RESEND_API_KEY` is empty. Use the magic-link URL printed in the server
terminal.

**GitHub features are unavailable**

Open **Settings → GitHub**, then install or reconnect the Jingler GitHub App. If Jingler is
connected but a repository is unavailable, use **Manage repositories** to add it to the
installation, or ask the installation owner to restore access if the installation is suspended.

**The auth server cannot connect to PostgreSQL**

Confirm the container is healthy with `docker compose ps`, then rerun:

```bash
pnpm --filter @jingler/server db:migrate
```

## Contributing

Before opening a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @jingler/desktop e2e
```

Add a Changeset with `pnpm changeset` for user-facing changes. CI runs the same lint, typecheck,
and unit-test gates on every pull request; the built Electron e2e is a required local release gate.

## Plugins

Jingler is extensible — plugins add tabs, dock panes and commands, dropped into
`~/jingler/plugins` or installed from **Settings › Plugins › Install from
folder…**. They appear without a restart.

- **Start from scratch:** `node scripts/create-jingler-plugin.mjs my-plugin`
- **Writing one:** [`packages/plugin-sdk/AGENTS.md`](packages/plugin-sdk/AGENTS.md) — the complete authoring contract
- **Overview, dev loop, distribution:** [`docs/plugins/README.md`](docs/plugins/README.md)
- **Something broken:** [`docs/plugins/debugging.md`](docs/plugins/debugging.md) — where each failure surfaces
- **Installing one:** [`docs/plugins/permissions-and-trust.md`](docs/plugins/permissions-and-trust.md) — read this first; a plugin runs with the app's full access
