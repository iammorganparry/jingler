# Writing a Starbase plugin

You are building a plugin for **Starbase**, a desktop agent harness. This file is
the complete contract. You should not need to read Starbase's source or search
the web to write a working plugin.

## The 60-second version

A plugin is a folder in `~/starbase/plugins/<id>/` containing a manifest and one
or two JavaScript entry points:

```
~/starbase/plugins/linear/
  starbase.plugin.json   ← the manifest (generated from src/manifest.ts)
  dist/ui.js             ← the renderer half: React components
  dist/main.js           ← the host half: Node, optional
```

The **UI half** renders tabs and panes. It runs in Starbase's renderer, shares
the app's React, and **cannot reach the network** — the renderer's CSP forbids
it.

The **host half** runs in Node inside Starbase's extension host. Anything
touching the network, a CLI, the filesystem or credentials goes here. It is
**optional**: a plugin that only displays local session data needs no host half
at all, and Starbase will never start a process for it.

## A complete, working plugin

Three files. Copy this and change the names.

### `src/manifest.ts`

```ts
import { defineManifest } from "@starbase/plugin-sdk"

export const manifest = defineManifest({
  id: "linear",                       // lowercase kebab-case; also the folder name
  name: "Linear",
  version: "1.0.0",
  ui: "dist/ui.js",
  main: "dist/main.js",               // omit for a UI-only plugin
  activationEvents: ["onTab:linear.issues"],
  contributes: {
    tabs: [{ id: "linear.issues", label: "Issues", icon: "CircleDot" }],
    commands: [{ id: "linear.sync", title: "Sync Linear" }]
  }
})
```

### `src/ui.tsx`

```tsx
import { definePlugin, useHost, type TabProps } from "@starbase/plugin-sdk"
import { useEffect, useState } from "react"
import { manifest } from "./manifest.js"

interface Issue { id: string; title: string }

function IssuesTab({ session }: TabProps) {
  const host = useHost()
  const [issues, setIssues] = useState<Issue[]>([])

  useEffect(() => {
    void host.invoke<Issue[]>("linear.sync", { repo: session.repo }).then(setIssues)
  }, [host, session.repo])

  return (
    <div className="flex-1 overflow-auto bg-editor p-4">
      <h2 className="text-[15px] font-semibold text-text">{session.repo}</h2>
      <ul className="mt-3 flex flex-col gap-1">
        {issues.map((issue) => (
          <li key={issue.id} className="rounded border border-line px-3 py-2 text-text-body">
            {issue.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default definePlugin(manifest, {
  views: { "linear.issues": IssuesTab }
})
```

### `src/main.ts`

```ts
import type { Activate } from "@starbase/plugin-sdk/host"

export const activate: Activate = async (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("linear.sync", async (arg) => {
      const { repo } = arg as { repo: string }

      // Credentials are requested, not declared. The operator sees a prompt
      // naming this plugin and these scopes, and can revoke later in Settings.
      const session = await ctx.authentication.getSession("github", ["repo"])
      if (!session) return []          // declined — degrade, do not throw

      // Plain `fetch` — the host half is Node, with no CSP in the way. It is
      // the UI half that cannot reach the network, which is why this call
      // lives here rather than in the tab component.
      const res = await fetch(`https://api.example.com/issues?repo=${repo}`, {
        headers: { authorization: `Bearer ${session.accessToken}` }
      })
      return (await res.json()) as Issue[]
    })
  )
}
```

## The five rules that actually catch people

### 1. Never bundle React

Starbase provides `react`, `react-dom`, `react/jsx-runtime` and
`@starbase/plugin-sdk` at runtime. Mark them external — `@starbase/plugin-sdk/vite`
does this for you:

```ts
// vite.config.ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { starbasePluginBuild } from "@starbase/plugin-sdk/vite"

export default defineConfig({
  plugins: [react()],
  build: starbasePluginBuild({ entry: "src/ui.tsx" })
})
```

Bundling your own React puts two Reacts in one tree and **every hook throws** —
but only once a *second* plugin is installed. Your plugin will work perfectly on
your machine and break on everyone else's.

### 2. Never hardcode a colour

Every colour in Starbase is a `--sb-*` custom property exposed to Tailwind:
`bg-editor`, `bg-panel`, `text-text`, `text-dim`, `text-blue`, `border-line`,
`text-green`, `text-red`, `text-yellow`.

A literal hex survives a theme switch unchanged — on a light theme that means
white text on white. Use the tokens and your tab is themed for free, including
in themes that did not exist when you wrote it.

### 3. Namespace every contribution id

Every id in `contributes` must be `<pluginId>.<local>`, e.g. `linear.issues`.
`defineManifest` enforces this at compile time. Two plugins both wanting a tab
called `issues` is the expected case; the namespace is what stops the second
silently shadowing the first.

### 4. Bump `version` to reload

ES module imports are cached by URL for the life of the window. Starbase keys
your module's URL by the manifest version, so **editing a file without bumping
`version` shows you the old module**. This is the single most common "my change
did nothing" report.

### 5. Declare what you implement

`definePlugin` requires a view for every tab in `contributes.tabs`, and rejects
views for tabs you did not declare. Both are compile errors. A plugin cannot
contribute something it did not declare — otherwise the enable switch in
Settings would be advisory.

## Permissions: there aren't any

There is no `permissions: ["github"]` field. Do not look for one.

A plugin that needs credentials asks at the moment it needs them:

```ts
const session = await ctx.authentication.getSession("github", ["repo"])
```

The operator sees a prompt naming your plugin, the provider and the scopes,
grants once, and can revoke later in Settings. `getSession` returns `null` if
they decline — **handle that by degrading, not by throwing**. Widening scopes
later prompts again.

The token never leaves the extension host. Do not try to send it to your UI half;
there is no route for it, by design.

## Activation

Your host half stays dormant until one of its `activationEvents` fires:

| Event | Fires when |
|---|---|
| `onTab:<contributionId>` | the operator opens that tab |
| `onCommand:<contributionId>` | the operator runs that command |
| `onStartupFinished` | the window is interactive |
| `repoContains:<glob>` | the active session's repo has a matching file |

Prefer the narrowest one. `onStartupFinished` costs startup time for work the
operator may never ask for.

**Omitting `activationEvents` entirely is valid** and correct for a UI-only
plugin — its tabs still render, and no Node process is ever started.

## Tab visibility

`when` on a tab declaration controls which sessions show it:

| `when` | Shown for |
|---|---|
| `"always"` (default) | every session |
| `"hasPr"` | sessions with a linked pull request |
| `"hasWorktree"` | sessions with a git worktree |
| `"hasIssue"` | sessions with a linked GitHub issue |

## What a tab receives

```ts
interface TabProps {
  session: SessionSnapshot
  pluginId: string
}

interface SessionSnapshot {
  id: string
  repo: string            // "owner/repo"
  branch: string
  title: string
  cli: "claude" | "codex" | "cursor" | "opencode" | "starbase"
  prNumber: number | null
  issueNumber?: number
  worktreePath?: string
}
```

`SessionSnapshot` is deliberately small. Starbase's internal session type has
~25 fields; this is the stable subset a plugin may couple to.

## Storage

Namespaced to your plugin, shared between both halves, persists across restarts:

```ts
// UI half
const store = usePluginStorage()
await store.set("lastSync", Date.now())
const last = await store.get<number>("lastSync")

// host half — same store
await ctx.storage.set("lastSync", Date.now())
```

All methods are async on both sides. The UI half's calls cross an IPC boundary.

## Editor support

Add `$schema` to your `starbase.plugin.json` for validation and completion in
any editor:

```json
{
  "$schema": "./node_modules/@starbase/plugin-sdk/starbase.plugin.schema.json",
  "id": "linear",
  "name": "Linear",
  "version": "1.0.0"
}
```

## Trust model — state this plainly to users

Plugins are **trusted code**, the same position VS Code takes. The UI half runs
in the renderer's own realm; the host half is Node with full access. The
consent-based auth flow and lazy activation are real boundaries, but this is not
a sandbox. Tell users to install plugins they trust.

## Checklist before you ship

1. `react` and `@starbase/plugin-sdk` are external in your build config
2. No hex colours — only `--sb-*` Tailwind tokens
3. Every contribution id starts with your plugin id
4. `version` bumped since the last load
5. `getSession` returning `null` degrades instead of throwing

## Where to look next

- `api-digest.md` in this package — every export with its signature, one page
- `starbase.plugin.schema.json` — the manifest's full validated shape
- Hover any SDK export in your editor — each carries a runnable `@example`
