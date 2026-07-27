# hello-tab

The smallest complete Jingler plugin: one tab, no host half, ~90 lines.

Copy this directory to start a plugin of your own. For the full contract see
`packages/plugin-sdk/AGENTS.md`.

## Try it

```bash
pnpm --filter @jingler-example/hello-tab build
pnpm --filter @jingler-example/hello-tab install:local
```

The tab appears in every session immediately — the app watches
`~/jingler/plugins` and reloads without a restart.

## What it demonstrates

| | |
|---|---|
| `src/manifest.ts` | The manifest, in TypeScript, so `definePlugin` can check the views against its ids |
| `src/ui.tsx` | A tab reading `session` and persisting a counter through `usePluginStorage` |
| `vite.config.ts` | The externals that stop React being bundled |
| `scripts/emit-manifest.mjs` | Generating `jingler.plugin.json` from the TS manifest |

## Three things this shape is deliberate about

**No `main`, no `activationEvents`.** This plugin only renders what the app
already knows, so it has no host half and Jingler never starts a Node process
for it. Add `main` only when you need the network, a CLI or credentials.

**The manifest is generated, not hand-written.** It is authored in TypeScript so
that renaming a tab id is a compile error in `ui.tsx` rather than a tab that
opens onto nothing. `pnpm build` writes the JSON Jingler reads.

**Every colour is a theme token.** `bg-editor`, `text-text`, `border-line`,
`text-green` — never a hex. A literal colour survives a theme switch unchanged,
which on a light theme means white text on white. Use the tokens and the tab is
correct in all nine bundled themes and any the operator adds later.

## Bump `version` to see changes

ES module imports are cached by URL for the life of the window, so Jingler keys
your module's URL by the manifest version. Editing a file without bumping
`version` in `src/manifest.ts` shows you the previous module — the single most
common "my change did nothing".

## Why `install:local` copies rather than symlinks

The `jingler-plugin://` handler resolves every request through `realpath` and
refuses anything landing outside the plugins root — which is what stops a plugin
serving `~/.ssh` through a symlink. A symlinked plugin directory would be served
exactly zero files. The guard is working; the script respects it.
