# Starbase plugins

Plugins add **tabs, dock panes and commands** to Starbase. They are VS
Code-shaped on purpose: `activationEvents`, `contributes`, `extensionKind`,
`capabilities` all mean what they mean there, so a plugin author who has written
an extension is not learning a second vocabulary for the same ideas.

## What works, and what is declared but refused

The manifest schema is VS Code's, which means it validates fields Starbase does
not yet honour. Rather than accept those and do nothing, **the loader refuses a
plugin that declares one** and says so in Settings › Plugins.

| Manifest field | Status |
|---|---|
| `contributes.tabs` | Works |
| `contributes.panes` | Works — dock panes, one per window |
| `contributes.commands` | Works — dispatched to your host half |
| `activationEvents`, `extensionDependencies` | Works |
| `apiVersion` | Works — a too-old Starbase refuses you by name |
| `contributes.keybindings` | **Refused** — validated, dispatched by nothing |
| `contributes.settings` | **Refused** — same |
| `contributes.authenticationProviders` | **Refused** — `registerProvider` is not implemented |
| `capabilities.untrustedRepos` | **Refused** — see below |
| `extensionKind` | Accepted and ignored; it is a hint, not a promise |

`capabilities.untrustedRepos` is refused rather than warned about because it is
not a feature a plugin wants — it is a promise a plugin *makes*, that named
contributions stay inert until the operator trusts a repo. Starbase has no
repo-trust model yet and would mount them regardless, so accepting the
declaration would turn a safety claim into decoration and mislead the author who
wrote it most carefully. Each row above stops being refused the moment its other
half lands.

## Where the documentation lives

Most of it is **in the SDK package**, not here, so it ships with the thing it
describes and cannot drift from it.

| You want | Read |
|---|---|
| To write a plugin | [`packages/plugin-sdk/AGENTS.md`](../../packages/plugin-sdk/AGENTS.md) |
| Every export and signature, one page | [`packages/plugin-sdk/api-digest.md`](../../packages/plugin-sdk/api-digest.md) |
| **Something is broken** | [`debugging.md`](./debugging.md) |
| The manifest's validated shape | `packages/plugin-sdk/starbase.plugin.schema.json` (generated) |
| Whether to trust a plugin | [`permissions-and-trust.md`](./permissions-and-trust.md) |
| A working example | [`plugins/examples/hello-tab`](../../plugins/examples/hello-tab) |
| A real one | [`plugins/github-issues`](../../plugins/github-issues) |

`AGENTS.md` is written for a coding agent, which means it is also the densest
and most complete thing to hand a human. Start there.

## Sixty seconds

```bash
node scripts/create-starbase-plugin.mjs my-plugin

# From the repo root. `pnpm install` links @starbase/plugin-sdk into the new
# package — skip it and the build fails with "Cannot find package
# '@starbase/plugin-sdk'", which does not obviously mean "run install".
pnpm install
pnpm -C plugins/my-plugin build
pnpm -C plugins/my-plugin install:local
```

The tab appears in every session immediately, with no restart.

**`install:local` writes to your real `~/starbase/plugins`.** To keep development
out of your actual setup, point `STARBASE_HOME` somewhere else — for the install
*and* for the app, or they will disagree about where plugins live:

```bash
export STARBASE_HOME=/tmp/starbase-dev
pnpm -C plugins/my-plugin install:local
pnpm --filter @starbase/desktop dev
```

### The edit loop, and the thing that catches everyone

```bash
# after every change:
pnpm -C plugins/my-plugin build && pnpm -C plugins/my-plugin install:local
```

Two facts that look contradictory and are both true:

- **Starbase reloads without a restart.** It watches `~/starbase/plugins`
  recursively, so a rebuilt file is noticed within a couple of hundred
  milliseconds.
- **Your change still will not appear unless `version` changed.** ES module
  imports are cached by URL for the life of the window. Starbase keys your module
  by the manifest version, so the version is what busts that cache.

So: bump `version` in `src/manifest.ts` as you work. The watcher notices the
rebuild either way, but the *code* only re-evaluates when the version moves. This
is the single most common "my change did nothing".

`install:local` copies `starbase.plugin.json` and `dist` — nothing else. Starbase
watches the installed copy, not your source tree, which is why the copy step is
not optional.

## Testing a plugin

There is no plugin test harness, and being honest about that is more useful than
pretending: `pnpm test` at the repo root globs `packages/*` and `apps/*`, not
`plugins/*`, so a Vitest suite inside your plugin would not run in CI.

What you get for free, and should rely on:

- **`pnpm typecheck` covers every plugin**, including yours the moment it is under
  `plugins/`. `defineManifest` + `definePlugin` turn a missing view, an
  undeclared id and an unnamespaced contribution into compile errors — most
  plugin bugs are shaped like that.
- **`pnpm build` covers every plugin** too, so an example that stops building
  fails CI.
- **Starbase's own e2e suite** (`apps/desktop/e2e/plugins.spec.ts`) exercises the
  loader, the protocol, the host process, storage, panes and hot reload against a
  real Electron app. If the platform breaks under you, that is where it shows.

For your own logic, keep it in plain functions the SDK does not touch and test
them however you like — the parts that need Starbase running are better covered
by opening the app than by mocking a bridge.

## Distributing a plugin

**There is no registry, no marketplace and no publish command.** Nothing is
planned in this release. Sharing a plugin today means sharing a folder:

1. `pnpm build` — produces `starbase.plugin.json` and `dist`.
2. Zip *those two things*. Not `src`, not `node_modules`: everything your plugin
   needs is bundled into `dist` already, and a `node_modules` beside the plugin is
   never consulted at runtime.
3. The recipient unzips it and uses **Settings › Plugins › Install from folder…**,
   or copies it into `~/starbase/plugins/<id>/` by hand. Either way it appears
   without a restart.

Set `apiVersion` in your manifest before you send it anywhere. A Starbase too old
to speak your API generation then refuses the plugin with a sentence naming both
versions, rather than evaluating your bundle against an SDK missing what it
expects.

What that install does **not** give the recipient, stated plainly because a zip
looks like a package and is not one:

- no signature, and no check that the folder is the one you built;
- no automatic updates — a new version is another zip and another install;
- no sandbox. A plugin runs with the same access as Starbase itself. See
  [`permissions-and-trust.md`](./permissions-and-trust.md) for exactly which
  boundaries are real and which are bookkeeping.

## The shape of it

```
~/starbase/plugins/my-plugin/
  starbase.plugin.json   generated from src/manifest.ts
  dist/ui.js             the renderer half — React, themed, no network
  dist/main.js           the host half — Node, optional
```

**UI half** renders tabs and panes. It runs in Starbase's renderer, shares the
app's React, and **cannot reach the network** — the renderer's CSP forbids it.
Import the themed component kit from `@starbase/plugin-sdk/ui` (`Markdown`,
`Spinner`, `Card`, `cn`, …) so a plugin looks like part of the app; it is
externalised, so it costs your bundle nothing.

**Host half** runs in Node in an extension host process. Anything touching the
network, a CLI, the filesystem or credentials goes here. It is **optional**: a
plugin that only displays what the app already knows needs no host half, and
Starbase never starts a process for it. Your own npm dependencies are **bundled
into `dist/main.js`** — there is no `node_modules` beside an installed plugin, so
never mark them external.

### Tabs and panes take different props

```ts
definePlugin(manifest, {
  views: { "my-plugin.main": Tab },       // session: SessionSnapshot
  panes: { "my-plugin.side": SidePane }   // session: SessionSnapshot | null
})
```

A tab belongs to one session. A dock pane is mounted once for the **window** and
follows whichever session has focus — including none — so it must render an empty
state for `null`. Panes go in the `panes` key; putting them in `views` is a load
error naming the pane.

## Six things that catch people

1. **Never bundle React.** Two Reacts in one tree makes every hook throw — but
   only once a *second* plugin is installed, so you will ship it having tested
   it. `@starbase/plugin-sdk/vite` sets the externals for you.
2. **Never hardcode a colour.** Use the `--sb-*` Tailwind tokens (`bg-editor`,
   `text-text`, `border-line`). A literal hex survives a theme switch unchanged,
   which on a light theme means white text on white.
3. **Bump `version` to see changes.** ES module imports are cached by URL for
   the life of the window, so Starbase keys your module by the manifest version.
   This is the most common "my change did nothing".
4. **Namespace every contribution id** as `<pluginId>.<local>`. `defineManifest`
   enforces it at compile time.
5. **Declare what you implement.** `definePlugin` requires a component for every
   tab *and every pane* your manifest declares, and rejects ones it does not.
   Both are compile errors.
6. **`ctx.exec` returns `code`, not `exitCode`**, and its `cwd` defaults to the
   host process's directory rather than your repo. Pass `session.worktreePath`
   for anything repo-shaped.

## Official plugins

`plugins/github-issues` ships with Starbase and is the reference for a plugin
with both halves. It takes **no shortcut for being official**: it reaches GitHub
through `getSession("github", ["repo"])`, the same consent-gated call a plugin
written this afternoon would use.

Official plugins are read from the app bundle rather than copied into
`~/starbase/plugins`. An installed plugin with the same id **wins**, so you can
run a fork or a fix without waiting for a release.

## Architecture, if you are changing Starbase itself

| Piece | Where |
|---|---|
| Manifest + contribution schemas | `packages/core/src/plugin.ts` |
| `Plugins.*` RPCs | `packages/contracts/src/index.ts` |
| Discovery, watching, install | `packages/cli-adapters/src/plugins.ts` |
| Extension host + protocol | `packages/cli-adapters/src/plugin-host.ts`, `apps/desktop/src/main/plugin-host-entry.ts` |
| Consent and grants | `packages/cli-adapters/src/plugin-auth.ts` |
| `starbase-plugin://` | `apps/desktop/src/main/plugin-protocol.ts` |
| Loading and mounting | `apps/desktop/src/renderer/plugin-{loader,registry,tab-host}.ts` |
| Tab / pane / keybinding registries | `packages/ui/src/app/*-contributions.ts` |

Each of those files opens with why it is shaped the way it is, including the
alternatives that were rejected and the bugs that shaped them.
