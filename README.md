# Jingler

Jingler is a desktop workspace for running coding agents across multiple projects. Projects are
registered once; each workspace is a separate coding session in either the project checkout or an
isolated git worktree, so agents can plan, edit, test, and open pull requests without colliding.

It is an Electron application backed by a small local authentication service. Jingler discovers
the coding CLIs already installed on your machine and keeps its desktop state in `~/jingler`.

## What you can do

- Run Claude Code or Codex CLI workspaces from one desktop app.
- Work on several tasks in parallel, each in an isolated git worktree.
- Review plans, diffs, agent activity, and pull requests without leaving the session.
- Inspect and control delegated Pi agents from the composer-integrated [Fleet](docs/subagent-fleet.md).
- Start work from a project checkout or a new isolated worktree.
- Use built-in terminals, browser previews, themes, MCP servers, and agent skills.

## Install

Download the installer for your platform from the
[latest release](https://github.com/iammorganparry/jingler/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Jingler-<version>-arm64.dmg` |
| macOS (Intel) | `Jingler-<version>-x64.dmg` |
| Windows | `Jingler-<version>-x64.exe` (also runs on Windows on ARM) |
| Linux | `Jingler-<version>-x86_64.AppImage` / `-amd64.deb` (arm64: `-arm64.AppImage`) |
| Arch Linux | `yay -S jingler-bin` (nightly: `jingler-nightly-bin`) |

Verify a download against `SHA256SUMS` on the same release. Jingler updates itself from the
sidebar; nightly builds follow the nightly channel.

## Requirements

- macOS, Windows, or Linux
- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 10.7.0
- [Docker](https://www.docker.com/) for the local PostgreSQL auth database
- Git and at least one supported coding CLI, already installed and signed in

Pull-request and issue features use an authenticated [GitHub CLI](https://cli.github.com/)
when available, with the Jingler GitHub App as fallback. Install the App only when you want
realtime review feedback.

Jingler currently requires Codex CLI 0.144 or newer. The app reports an upgrade command if it
finds an older version.

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

## First project and workspace

1. Choose **Add project** and register an existing git directory. Registering a project does not
   create a coding session or worktree.

2. Choose **New workspace**, select the project and branch, then decide whether to work directly
   in the project checkout or create an isolated worktree. Select Claude Code or Codex; the model,
   mode, and reasoning menus show only capabilities supported by that selection.

3. Create the workspace. An isolated worktree starts detached at the latest available
   `origin/<base>` (or the safe local base while offline) under
   `~/jingler/worktrees`. After the first task-understanding turn, Jingler
   validates the agent's metadata and creates a conventional `type/kebab-slug`
   branch itself.

4. Describe the task in the composer. In Plan mode, the pinned Plannotator extension owns the
   structured Markdown plan, review decision, automatic same-session execution, checklist
   progress, and recovery. Jingler packages Plannotator's review surface in the Plan tab without a
   localhost server and mirrors its checklist into the native plan drawer, progress dock, composer,
   todo list, and transcript without storing a second plan state. Each `##` plan stage is sized as a
   logical commit boundary; its Markdown checkbox markers are the durable step statuses.

5. If the Jingler GitHub App is connected, create or link a pull request from the PR view.

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

The desktop stores registered projects, workspaces (sessions), transcripts, themes, worktrees, and
encrypted auth state under `~/jingler`. Set `JINGLER_HOME` before starting the app to use another
location. Legacy sessions are linked to stable project records on read without moving their
worktrees or changing transcript identity.

The desktop connects to `http://localhost:9100` by default. Set `JINGLER_AUTH_URL` to point it at
another auth service.

### Web search

Research agents use the **WebSearch** tool instead of driving the app browser. On first interactive
use, choose EXA, Firecrawl, or Skip; keys can be added, replaced, or cleared later under
**Settings → General → Web search**. Keys are encrypted locally and synchronized as revocable,
encrypted capabilities for managed Cloud sessions. Cloud and paired-device daemons never advertise
browser tools: without a custom provider or verified model-native search they return an explicit
unavailable result rather than waiting for a desktop client. The in-app browser remains available
separately for preview QA, screenshots, and application testing.

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
| `packages/core` | Shared domain models, schemas, and plan logic |
| `packages/cli-adapters` | Coding-agent, git, GitHub, terminal, session, and workspace services |
| `packages/ui` | Shared React components, screens, styles, and themes |

The monorepo uses Turborepo and pnpm workspaces. Shared packages export TypeScript source directly,
so development changes are picked up without a separate package build.

GitHub App registration, Vercel configuration, and credential rotation are
documented in [apps/server/README.md](apps/server/README.md#github-app-registration).
Webhook relay deployment, replay, and incident recovery are documented in
[apps/github-relay/README.md](apps/github-relay/README.md).

## Desktop releases

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on two
channels, each with its own auto-update feed:

| Channel | How it starts | Version | Feed |
|---|---|---|---|
| Stable | Run **Release** manually (`channel: stable`) with at least one pending Changeset | `X.Y.Z` from Changesets | `latest*.yml`, marked *latest* |
| Nightly | Daily schedule (skipped when `main` has not moved), or **Release** with `channel: nightly` | `<next patch>-nightly.<date>.<run>` | `nightly*.yml`, prerelease |

Each run gates on lint, typecheck, unit tests and licenses, then builds macOS arm64 + x64, Linux
x64 + arm64 (AppImage) and Windows x64 installers. Every build passes the packaged-artifact check and
boots the packaged app for 20 seconds before anything publishes. The arm64 Linux build is
best-effort and never blocks a release. The release carries every installer, merged
per-channel update manifests, blockmaps for differential updates, and `SHA256SUMS`.

Signing is optional per platform and never blocks a build:

- **macOS** — signed and notarized when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are all set. Unsigned apps open
  via right-click → **Open** (or **System Settings → Privacy & Security**), but cannot
  auto-install updates.
- **Windows** — Azure Trusted Signing when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` are
  all set.
- **Linux** — unsigned.

After publishing, the AUR job repackages the x86_64 AppImage as `jingler-bin` (stable) or
`jingler-nightly-bin` (nightly) when `AUR_SSH_PRIVATE_KEY` is set; otherwise it is skipped.

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

Built-in GitHub reads and writes prefer the authenticated `gh` CLI. The GitHub App remains the
fallback and supplies realtime feedback; its installation credentials stay in the Electron main
process and are never persisted or returned to the renderer. Publishing without the App uses the
machine's configured Git credentials.

## Troubleshooting

**No repositories appear**

Choose the directory that contains your repositories, not an individual repository. Jingler
stops scanning after three nested directory levels and ignores build and dependency directories.

**No coding CLI is available**

Install and authenticate Claude Code or Codex CLI, then reopen the workspace composer. GUI
applications can have a limited `PATH`; Jingler also checks common install locations such as
`~/.local/bin` and `/opt/homebrew/bin`.

**Sign-in email does not arrive in local development**

This is expected when `RESEND_API_KEY` is empty. Use the magic-link URL printed in the server
terminal.

**GitHub features are unavailable**

Run `gh auth login`, or open **Settings → GitHub** to install/reconnect the Jingler GitHub App.
If an App-connected repository is unavailable, use **Manage repositories** to add it to the
installation, or ask the installation owner to restore access if it is suspended.

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
