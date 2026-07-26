# Starbase

Starbase is a desktop workspace for running coding agents across multiple repositories. Each
session gets its own git branch and isolated worktree, so agents can plan, edit, test, and open
pull requests without colliding with one another.

It is an Electron application backed by a small local authentication service. Starbase discovers
the coding CLIs already installed on your machine and keeps its desktop state in `~/starbase`.

## What you can do

- Run Claude Code, Codex CLI, Cursor Agent, or OpenCode sessions from one desktop app.
- Work on several tasks in parallel, each in an isolated git worktree.
- Review plans, diffs, agent activity, and pull requests without leaving the session.
- Start work from a new branch, an existing GitHub pull request, or a GitHub issue.
- Use built-in terminals, browser previews, themes, MCP servers, and agent skills.

## Requirements

- macOS, Windows, or Linux
- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 10.7.0
- [Docker](https://www.docker.com/) for the local PostgreSQL auth database
- Git and at least one supported coding CLI, already installed and signed in

[GitHub CLI](https://cli.github.com/) is optional. Install it and run `gh auth login` to enable
pull-request and issue features.

Starbase currently requires Codex CLI 0.144 or newer and OpenCode 1.18 or newer. The app reports
an upgrade command if it finds an older version.

## Run Starbase from source

1. Clone the repository and install dependencies.

   ```bash
   git clone https://github.com/iammorganparry/starbase.git
   cd starbase
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
   pnpm --filter @starbase/server db:migrate
   ```

4. Start the auth server and desktop app.

   ```bash
   pnpm dev
   ```

   The server listens on `http://localhost:9100`, and Electron opens the Starbase window.

5. Sign in with an email address.

   In local development, copy the magic-link URL printed by the server process and open it in
   your browser. The browser redirects back to the desktop app through the `starbase://` protocol.

## First session

1. On the welcome screen, choose the parent folder that contains your git repositories, such as
   `~/repos`. Starbase scans for repositories up to three directories deep.

2. Open **New session** or press <kbd>⌘</kbd><kbd>N</kbd>, then select a repository and base
   branch. The default coding CLI is configured under **Settings → Providers**.

3. Create the session. Starbase forks a branch into an isolated worktree under
   `~/starbase/worktrees` and opens the conversation for that worktree.

4. Describe the task in the composer. Use the plan controls when you want a reviewable plan before
   implementation, and inspect file changes from the session's changes view.

5. If GitHub CLI is connected, create or link a pull request from the PR view. Sessions can also
   be created directly from open pull requests or issues.

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
pnpm --filter @starbase/desktop dev
pnpm --filter @starbase/server dev
pnpm --filter @starbase/server test:integration
pnpm --filter @starbase/desktop e2e
pnpm --filter @starbase/desktop electron:pack
```

The integration tests require the Docker database and applied migrations. The Electron
Playwright suite runs locally and is not part of CI.

## Configuration and data

The desktop stores configuration, sessions, transcripts, themes, worktrees, and encrypted auth
state under `~/starbase`. Set `STARBASE_HOME` before starting the app to use another location.

The desktop connects to `http://localhost:9100` by default. Set `STARBASE_AUTH_URL` to point it at
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
| `packages/core` | Shared domain models, schemas, and orchestration logic |
| `packages/cli-adapters` | Coding-agent, git, GitHub, terminal, session, and workspace services |
| `packages/ui` | Shared React components, screens, styles, and themes |

The monorepo uses Turborepo and pnpm workspaces. Shared packages export TypeScript source directly,
so development changes are picked up without a separate package build.

## Troubleshooting

**No repositories appear**

Choose the directory that contains your repositories, not an individual repository. Starbase
stops scanning after three nested directory levels and ignores build and dependency directories.

**No coding CLI is available**

Install and authenticate Claude Code, Codex CLI, Cursor Agent, or OpenCode, then reopen the new
session dialog. GUI applications can have a limited `PATH`; Starbase also checks common install
locations such as `~/.local/bin` and `/opt/homebrew/bin`.

**Sign-in email does not arrive in local development**

This is expected when `RESEND_API_KEY` is empty. Use the magic-link URL printed in the server
terminal.

**GitHub features are unavailable**

Install GitHub CLI, run `gh auth login`, and use the welcome screen's recheck action or restart
Starbase.

**The auth server cannot connect to PostgreSQL**

Confirm the container is healthy with `docker compose ps`, then rerun:

```bash
pnpm --filter @starbase/server db:migrate
```

## Contributing

Before opening a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Add a Changeset with `pnpm changeset` for user-facing changes. CI runs the same lint, typecheck,
and unit-test gates on every pull request.

## Plugins

Starbase is extensible — plugins add tabs, dock panes, commands and
keybindings, dropped into `~/starbase/plugins`.

- **Writing one:** [`packages/plugin-sdk/AGENTS.md`](packages/plugin-sdk/AGENTS.md)
- **Installing one:** [`docs/plugins/permissions-and-trust.md`](docs/plugins/permissions-and-trust.md) — read this first
- **Start from scratch:** `node scripts/create-starbase-plugin.mjs my-plugin`
