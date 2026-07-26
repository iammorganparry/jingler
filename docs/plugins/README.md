# Starbase plugins

Plugins add tabs, dock panes and commands to Starbase. (Keybinding and settings
contributions are declared in the schema but not yet wired — a manifest using
one fails to load with a message saying so, rather than silently doing nothing.) They are
VS Code-shaped on purpose: `activationEvents`, `contributes`, `extensionKind`,
`capabilities` all mean what they mean there, so a plugin author who has written
an extension is not learning a second vocabulary for the same ideas.

## Where the documentation lives

Most of it is **in the SDK package**, not here, so it ships with the thing it
describes and cannot drift from it.

| You want | Read |
|---|---|
| To write a plugin | [`packages/plugin-sdk/AGENTS.md`](../../packages/plugin-sdk/AGENTS.md) |
| Every export and signature, one page | [`packages/plugin-sdk/api-digest.md`](../../packages/plugin-sdk/api-digest.md) |
| The manifest's validated shape | `packages/plugin-sdk/starbase.plugin.schema.json` (generated) |
| Whether to trust a plugin | [`permissions-and-trust.md`](./permissions-and-trust.md) |
| A working example | [`plugins/examples/hello-tab`](../../plugins/examples/hello-tab) |
| A real one | [`plugins/github-issues`](../../plugins/github-issues) |

`AGENTS.md` is written for a coding agent, which means it is also the densest
and most complete thing to hand a human. Start there.

## Sixty seconds

```bash
node scripts/create-starbase-plugin.mjs my-plugin
cd plugins/my-plugin
pnpm install && pnpm build && pnpm install:local
```

The tab appears in every session immediately. Starbase watches
`~/starbase/plugins` and reloads without a restart.

## The shape of it

```
~/starbase/plugins/my-plugin/
  starbase.plugin.json   generated from src/manifest.ts
  dist/ui.js             the renderer half — React, themed, no network
  dist/main.js           the host half — Node, optional
```

**UI half** renders tabs and panes. It runs in Starbase's renderer, shares the
app's React, and **cannot reach the network** — the renderer's CSP forbids it.

**Host half** runs in Node in an extension host process. Anything touching the
network, a CLI, the filesystem or credentials goes here. It is **optional**: a
plugin that only displays what the app already knows needs no host half, and
Starbase never starts a process for it.

## Five things that catch people

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
5. **Declare what you implement.** `definePlugin` requires a view for every tab
   your manifest declares, and rejects views for tabs it does not. Both are
   compile errors.

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
