# GitHub Issues — the reference Jingler plugin

Shows the GitHub issue linked to a session, in a tab beside the conversation.

This is the plugin to read if you are writing one. `plugins/examples/hello-tab`
is smaller and shows the minimum; this one is a **real plugin with both halves**,
which means it has to answer every question a real plugin does: where does the
network call go, how does it get credentials, what does it do while loading, what
does it do when there is no issue.

## What it demonstrates

| Concern | Where |
|---|---|
| A tab that hides itself when irrelevant | `when: "hasIssue"` in `src/manifest.ts` |
| A host half doing the network work | `src/main.ts` |
| Consent-gated credentials | `getSession("github", ["issues:read", "repository:owner/name"])` in `src/main.ts` |
| GitHub App REST access | Host-side `fetch` with a short-lived installation credential |
| Legacy folder-only sessions | Host-side `git remote get-url origin` resolution; no GitHub CLI |
| UI → host over a command | `contributes.commands` + `host.invoke` |
| Themed components, no hardcoded colour | `@jingler/plugin-sdk/ui` in `src/ui.tsx` |
| Activating lazily | `activationEvents: ["onTab:github-issues.issue"]` |

## It takes no shortcut for being official

Jingler already holds GitHub credentials, and this plugin ships inside the app,
so handing it a token directly would be easy and invisible. It asks for one
instead — through the same repository-qualified `getSession("github", …)` a plugin
written this afternoon would call, producing the same native consent prompt,
recorded in the same revocable grant list in Settings › Plugins.

That is the only honest test of whether the permission model is real rather than
decorative, and it is why `src/main.ts` does the boring thing.

## The split, and why it is not optional

The renderer's CSP does not widen `connect-src`. A plugin's tab therefore has **no
route to the network**, however much code it runs. Everything outbound goes
through the extension host, which is also where the operator's consent lives.

So: `src/ui.tsx` renders and asks; `src/main.ts` fetches from GitHub's REST API.
The host receives a short-lived credential for the matching GitHub App
installation. The UI receives only the normalized issue, never the credential,
raw response, or authorization headers. This is not a style preference — the UI
half physically cannot do the other job.

The plugin does not execute GitHub CLI. The bundled integration therefore works
on a machine with Git and no `gh` binary. A separately installed third-party
plugin remains trusted Node code and can choose to launch subprocesses; that is
outside this provider's supported path.

## Building and running it

```bash
# From the repo root.
pnpm install
pnpm -C plugins/github-issues build
```

In **development you do not need to install it**: `builtinPluginsRoot()` resolves
to the repo's own `plugins/` directory when the app is not packaged, so the copy
you just built is the copy the running app loads. Edit, rebuild, bump `version`
in `src/manifest.ts`, and the change is live.

In a **packaged** build it is staged into `resources/plugins` by the
`extraResources` block in `apps/desktop/electron-builder.yml`, and
`apps/desktop/scripts/build-bundled-plugins.mjs` builds it and refuses to package
if any entry file the manifest names is missing.

## Installed copies win

An installed plugin with the same id shadows this one. So you can run a fork or a
fix out of `~/jingler/plugins/github-issues` without waiting for a release, and
Settings shows which copy is in use. Uninstall is refused for the bundled copy —
in development that directory is checked-in source, and one click would delete it.

## Files

```
src/manifest.ts     the manifest, in TypeScript so ids are literal types
src/ui.tsx          the tab — React, themed, no network
src/main.ts         the host half — consent, GitHub App REST fetch, normalization
src/main.test.ts    REST mapping, pagination, endpoint isolation and redaction
scripts/emit-manifest.mjs   writes jingler.plugin.json from src/manifest.ts
scripts/install-local.mjs   copies manifest + dist into ~/jingler/plugins
```

`jingler.plugin.json` is **generated**. Editing it works until the next build
overwrites it; change `src/manifest.ts` instead.

## Further reading

- [`packages/plugin-sdk/AGENTS.md`](../../packages/plugin-sdk/AGENTS.md) — the authoring contract
- [`docs/plugins/debugging.md`](../../docs/plugins/debugging.md) — where each kind of failure surfaces
- [`docs/plugins/permissions-and-trust.md`](../../docs/plugins/permissions-and-trust.md) — which boundaries are real
