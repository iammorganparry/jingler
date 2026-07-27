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

Your own npm dependencies are **bundled into your output** — there is no
`node_modules` beside an installed plugin, so never mark them external. Only the
six specifiers Starbase supplies at runtime are external, and
`@starbase/plugin-sdk/vite` already lists them.

### Four import paths

| Import from | Runs in | Gives you |
|---|---|---|
| `@starbase/plugin-sdk` | renderer | `definePlugin`, `defineManifest`, hooks, types |
| `@starbase/plugin-sdk/ui` | renderer | the themed component kit — use this before writing your own |
| `@starbase/plugin-sdk/host` | extension host | `HostContext`, `Activate`, credentials, `exec` |
| `@starbase/plugin-sdk/vite` | your build | `starbasePluginBuild`, `STARBASE_EXTERNALS` |

`@starbase/plugin-sdk/ui` is what makes a plugin look like part of the app rather
than a webpage inside it: `Markdown`, `Spinner`, `Card`, `Callout`, `Badge`,
`Avatar`, `Input`, `Toggle`, `Kbd`, `cn`, `relativeTime`, `useWidthTier` and more.
It is externalised, so importing it costs your bundle nothing. See `api-digest.md`
for the full list.

### Set `apiVersion`

```ts
apiVersion: 1,   // the plugin API generation you built against
```

Optional, and worth setting before you share a plugin with anyone. A Starbase too
old to speak your generation refuses the plugin with a sentence naming both
versions; without it, the same mismatch is a stack trace from inside your bundle
on someone else's machine. Only breaking changes to what a plugin sees bump it, so
a new hook or contribution point never will.

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
      // Prompting is the default, so this resolves to a session or REJECTS if
      // the operator declines — no null check needed on the happy path.
      const session = await ctx.authentication.getSession("github", ["repo"])

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

`definePlugin` requires a component for every id in `contributes.tabs` **and**
`contributes.panes`, and rejects components for ids you did not declare. Both are
compile errors. A plugin cannot contribute something it did not declare —
otherwise the enable switch in Settings would be advisory.

### 6. Dock panes go in `panes`, not `views`

```ts
export default definePlugin(manifest, {
  views: { "linear.issues": IssuesTab },       // session: SessionSnapshot
  panes: { "linear.activity": ActivityPane }   // session: SessionSnapshot | null
})
```

They are separate keys because the props differ, and the props differ because the
mounting scope does:

- a **tab** belongs to one session and cannot exist without it;
- a **pane** is mounted once for the **window** and follows whichever session has
  focus — including none, when the last session is closed.

So a pane must handle `session === null` and render an empty state. Putting a pane
in `views` is a load error naming the pane; you will see it in Settings › Plugins.

**All the hooks work in a pane**, with one substitution: use `useSessionOrNull()`
instead of `useSession()`. `useSession` returns a non-nullable snapshot for tabs,
which cannot be honest in a pane with nothing open, so it throws there with a
message pointing at the alternative.

```tsx
function ActivityPane() {
  const host = useHost()               // fine
  const storage = usePluginStorage()   // fine
  const session = useSessionOrNull()   // null when nothing is open
  if (!session) return <div className="text-dim">No session selected.</div>
  return <div className="text-text">{session.repo}</div>
}
```

A pane that throws gets its own error card scoped to the dock, and the rest of the
app keeps working — the same containment a tab gets.

## Fields Starbase refuses

The manifest schema is VS Code's, so it validates several things Starbase does not
yet honour. Declaring one is a **load failure**, not a silent no-op:

- `contributes.keybindings`
- `contributes.settings`
- `contributes.authenticationProviders`
- `capabilities.untrustedRepos`
- `activationEvents: ["repoContains:…"]` — the other three events work; see [Activation](#activation)

Do not put them in a manifest. A plugin declaring any of them contributes nothing
at all and shows a message in Settings › Plugins saying which field and why. The
refusal is deliberate: a keybinding that never fires or a trust promise that is
never honoured is worse than an error, because there is nothing to search for.

`extensionKind` is accepted and ignored — it is a hint, not a promise.

### Entry points must cover what you contribute

Two more load failures, for the same reason: a contribution nothing can serve is
worse than an error.

- `contributes.tabs` or `contributes.panes` with **no `ui`** — the views live in
  the UI half.
- `contributes.commands` with **no `main`** — the handlers live in the host half
  (`ctx.commands.register`), and Starbase will not start a host process for a
  plugin that has no `main`. Without this check the command appears in the
  command palette, runs nothing, and looks like your handler is broken.

## Permissions: there aren't any

There is no `permissions: ["github"]` field. Do not look for one.

A plugin that needs credentials asks at the moment it needs them:

```ts
const session = await ctx.authentication.getSession("github", ["repo"])
```

The operator sees a prompt naming your plugin, the provider and the scopes,
grants once, and can revoke later in Settings. Widening scopes later prompts
again.

Declining **rejects** the promise, mirroring VS Code — so a command that needs
an account fails loudly rather than continuing half-configured. To ask without
prompting, pass `{ createIfNone: false }`; that resolves `undefined` when there
is no existing grant, which is the form to use when your tab should render
something useful either way.

The token never leaves the extension host. Do not try to send it to your UI half;
there is no route for it, by design.

## Activation

Your host half stays dormant until one of its `activationEvents` fires:

| Event | Fires when | Dispatched |
|---|---|---|
| `onTab:<contributionId>` | the operator opens that tab | yes |
| `onCommand:<contributionId>` | the operator runs that command | yes |
| `onStartupFinished` | the app has finished starting | yes |
| `repoContains:<glob>` | the active session's repo has a matching file | **no — refused at load** |

Prefer the narrowest one. `onStartupFinished` costs startup time for work the
operator may never ask for.

`repoContains:` is in the manifest schema and matching a glob against a session's
repo is implemented by nothing, so a plugin waiting on it would wait forever.
Declaring it is a load failure, like the fields in the previous section — the other
three all work, so only this one is refused.

**Omitting `activationEvents` entirely is valid** and correct for a UI-only
plugin — its tabs still render, and no Node process is ever started.

A plugin that is **disabled** is never activated by any event, including
`onStartupFinished`. "Disabled" means it runs no code, and disabling one also tears
down a host half that is already running.

### Activation is not the same as an invoke

Worth stating because it used to be untrue. `activate()` was once reachable only
through `invoke()`, which made `onTab` *appear* to work — a tab's first render
usually calls `host.invoke(...)`, and activation happened as a side effect on the
way past. A tab that rendered from `session` alone got nothing, and
`onStartupFinished` never fired at all.

Both are dispatched properly now, so you can rely on `activate` having run before
your first command, and on a host half that only subscribes to events actually
starting.

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

## Changing the session

A snapshot is read-only. The one mutation a plugin may make is detaching the
session's linked issue:

```tsx
const session = useSession()
const { unlinkIssue } = useSessionActions()

<button type="button" onClick={() => void unlinkIssue(session.id)}>Unlink</button>
```

It resolves once the app's own state has been updated, so the next render sees
the change — you do not have to reload anything.

**This list is short and stays short.** A plugin DECORATES a session; it does not
drive one. There is no `setStatus`, no `rename`, no `archive`, and adding one
means arguing that the operator can only reach it through the plugin that owns
the concept. `unlinkIssue` clears that bar because the app knows a session *has*
a linked issue while the plugin owns the UI where "actually, not that one"
belongs.

It is not a security boundary: any installed plugin can unlink any session's
issue, and nothing prompts. That is an accepted risk because it is trivially
reversible — see `docs/plugins/permissions-and-trust.md`.

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

## The dev loop

```bash
# once, from the repo root — links @starbase/plugin-sdk into your package
pnpm install

# after every change
pnpm -C plugins/my-plugin build && pnpm -C plugins/my-plugin install:local
```

Starbase watches `~/starbase/plugins` **recursively**, so the rebuilt file is
noticed in under a second with no restart. But `install:local` copies only
`starbase.plugin.json` and `dist` into that directory — it does not watch your
source tree — so the copy step is not optional, and neither is bumping `version`
(rule 4).

`install:local` writes to your **real** `~/starbase`. To keep development
separate, set `STARBASE_HOME` for both the install and the app:

```bash
export STARBASE_HOME=/tmp/starbase-dev
```

## When something breaks

`docs/plugins/debugging.md` in the Starbase repo is the map. The short version:

- **UI half** → renderer devtools (`Cmd+Opt+I` / `Ctrl+Shift+I`)
- **Host half** → the terminal running `pnpm dev` (`ctx.log` and `console.log` both)
- **Anything that stopped the plugin loading** → Settings › Plugins, in its row

Starbase never fails a plugin silently. If you get nothing anywhere, that is a bug
in Starbase, not in your plugin.

## Testing

There is no plugin test harness, and `pnpm test` at the repo root does not glob
`plugins/*` — a Vitest suite inside your plugin would not run in CI. What does
cover you: `pnpm typecheck` and `pnpm build` include every plugin, and
`defineManifest`/`definePlugin` turn a missing component, an undeclared id and an
unnamespaced contribution into compile errors. Keep your own logic in plain
functions and test those directly.

## Sharing a plugin

There is no registry and no publish command. `pnpm build`, then zip
`starbase.plugin.json` and `dist` — nothing else, since your dependencies are
already bundled. The recipient uses **Settings › Plugins › Install from folder…**
or copies it to `~/starbase/plugins/<id>/`. No signing, no auto-update, no sandbox.

## Checklist before you ship

1. `react` and `@starbase/plugin-sdk` are external in your build config
2. `apiVersion` is set
3. No hex colours — only `--sb-*` Tailwind tokens
4. Every contribution id starts with your plugin id
5. `version` bumped since the last load
6. A declined `getSession` is handled — it rejects unless you pass `createIfNone: false`
7. No `keybindings`, `settings`, `authenticationProviders` or `capabilities.untrustedRepos`
8. If your manifest declares `main`, your build config passes `main` too

## Where to look next

- `api-digest.md` in this package — every export with its signature, one page
- `starbase.plugin.schema.json` — the manifest's full validated shape
- `plugins/github-issues/README.md` — a real plugin with both halves, annotated
- `docs/plugins/debugging.md` — where each kind of failure surfaces
- Hover any SDK export in your editor — each carries a runnable `@example`
