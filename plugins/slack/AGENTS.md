# Slack — a Jingler plugin

The complete authoring contract is in
`packages/plugin-sdk/AGENTS.md`, and every export is listed in
`packages/plugin-sdk/api-digest.md`. Read the first one before changing
anything here.

## This plugin

- `src/manifest.ts` — what it contributes. Bump `version` to see edits.
- `src/ui.tsx` — the tab. Only `--sb-*` theme tokens, never hex colours.
- No host half yet. Add `src/main.ts` plus `main: "dist/main.js"` in the
  manifest AND `main: "src/main.ts"` in `vite.config.ts` when you need the
  network, a CLI or credentials — the renderer can reach none of those.

## Commands

```bash
pnpm build          # bundle + regenerate jingler.plugin.json
pnpm install:local  # copy into ~/jingler/plugins
pnpm typecheck
```
