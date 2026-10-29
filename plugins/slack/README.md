# Slack

A Jingler plugin.

```bash
pnpm install
pnpm build
pnpm install:local
```

The tab appears in every session immediately — Jingler watches
`~/jingler/plugins` and reloads without a restart.

Editing and seeing nothing? Bump `version` in `src/manifest.ts`. Module imports
are cached by URL for the life of the window.

See `packages/plugin-sdk/AGENTS.md` for the full contract.
