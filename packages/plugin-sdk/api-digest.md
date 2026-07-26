# `@starbase/plugin-sdk` — API digest

Every export, with its signature and one line of purpose. For the narrative
version see `AGENTS.md`; for the manifest's validated shape see
`starbase.plugin.schema.json`.

Four entrypoints, deliberately separate so a host-only plugin never pulls React
into Node and a UI-only plugin never pulls Node types into the browser:

| Import from | Runs in | Use for |
|---|---|---|
| `@starbase/plugin-sdk` | Starbase's renderer | tabs, panes, React components |
| `@starbase/plugin-sdk/ui` | Starbase's renderer | the themed component kit |
| `@starbase/plugin-sdk/host` | Node, in the extension host | network, CLIs, credentials |
| `@starbase/plugin-sdk/vite` | your build | externals config |

---

## `@starbase/plugin-sdk` — authoring

### `defineManifest`

```ts
function defineManifest<const M extends ManifestInput>(manifest: M): M
```

Declares a manifest with contribution ids captured as literal types. Returns its
input unchanged. Rejects, at compile time, any contribution id not namespaced
under the plugin's own id.

### `definePlugin`

```ts
function definePlugin<const M extends ManifestInput>(
  manifest: M,
  impl: {
    views: { [K in TabIdsOf<M>]: ComponentType<TabProps> }   // required iff tabs declared
    panes: { [K in PaneIdsOf<M>]: ComponentType<PaneProps> } // required iff panes declared
  }
): Plugin<M>
```

Binds components to declared tabs and dock panes. Missing a declared one is a
compile error; supplying an undeclared one is a compile error. Each key is
optional when the manifest declares nothing of that kind, so a pane-only plugin
does not have to write `views: {}`. The return value is what your UI module must
`export default`.

**Tabs and panes are different props**, because they are mounted at different
scopes:

```ts
interface TabProps  { session: SessionSnapshot;        pluginId: string }
interface PaneProps { session: SessionSnapshot | null; pluginId: string }
```

A tab belongs to one session and cannot exist without it. A dock pane is mounted
once for the **window** and follows whichever session has focus — including none,
when the last session is closed. A pane must render an empty state for `null`.

```ts
export default definePlugin(manifest, {
  views: { "linear.issues": IssuesTab },
  panes: { "linear.activity": ActivityPane }
})
```

---

## `@starbase/plugin-sdk` — hooks

All throw if called outside a plugin view. All work in a contributed **tab or dock
pane** — in a pane, substitute `useSessionOrNull` for `useSession`.

### `useHost`

```ts
function useHost(): HostBridge
```

The bridge to your plugin's host half and its storage.

### `useSession`

```ts
function useSession(): SessionSnapshot
```

The session this tab is decorating — the same value as `props.session`.

### `useSessionOrNull`

```ts
function useSessionOrNull(): SessionSnapshot | null
```

The pane-safe counterpart to `useSession`. A dock pane outlives any one session, so
it must render an empty state; `useSession` throws in that moment rather than
widening its return type for every tab that cannot hit the case. In a tab this
never returns null and `useSession` is the better call.

### `useSessionActions`

```ts
function useSessionActions(): SessionActions
```

The short list of session mutations a plugin may make. Currently only
`unlinkIssue`. See `SessionActions` for why the list stays short.

### `usePluginStorage`

```ts
function usePluginStorage(): PluginStorage
```

Your plugin's persistent key/value store. Shared with the host half.

### `useCommand`

```ts
function useCommand<T = unknown>(commandId: string): (arg?: unknown) => Promise<T>
```

A bound callable for one of your host commands.

---

## `@starbase/plugin-sdk` — types

### `TabProps`

```ts
interface TabProps {
  readonly session: SessionSnapshot
  readonly pluginId: string
}
```

What a tab view component receives.

### `SessionSnapshot`

```ts
interface SessionSnapshot {
  readonly id: string
  readonly repo: string          // "owner/repo"
  readonly branch: string
  readonly title: string
  readonly cli: "claude" | "codex" | "cursor" | "opencode" | "starbase"
  readonly prNumber: number | null
  readonly issueNumber?: number
  readonly worktreePath?: string
}
```

The deliberately small, stable subset of a session a plugin may couple to.

### `HostBridge`

```ts
interface HostBridge {
  invoke<T = unknown>(commandId: string, arg?: unknown): Promise<T>
  readonly storage: PluginStorage
  openExternal(url: string): Promise<void>
  readonly sessions: SessionActions
}
```

`invoke` is the only route from a plugin's UI to anything outside the renderer.

### `SessionActions`

```ts
interface SessionActions {
  unlinkIssue(sessionId: string): Promise<void>
}
```

Mutations a plugin may make to the session it is decorating. Deliberately tiny,
and it stays that way: a plugin DECORATES a session, it does not drive one. An
entry earns its place by being something the operator can only reach through the
plugin that owns the concept — `unlinkIssue` qualifies because the app knows a
session has a linked issue but the plugin owns the UI where "not that one"
belongs.

Not a security boundary: any installed plugin can unlink any session's issue and
nothing prompts. Reversible, and re-linking is also available, which is why it is
allowed at all — see `docs/plugins/permissions-and-trust.md`.

### `PluginStorage`

```ts
interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<readonly string[]>
}
```

Namespaced to your plugin, persisted by the host, async on both sides.

### `ManifestInput`

```ts
interface ManifestInput {
  readonly id: string                  // lowercase kebab-case; the folder name
  readonly name: string
  readonly version: string             // bump to force a reload
  readonly description?: string
  readonly publisher?: string
  readonly apiVersion?: number         // the API generation you built against; set it
  readonly ui?: string                 // renderer entry, relative to plugin dir
  readonly main?: string               // host entry, relative to plugin dir
  readonly activationEvents?: readonly ActivationEvent[]
  readonly extensionDependencies?: readonly string[]
  readonly contributes?: {
    readonly tabs?: readonly TabDeclaration[]
    readonly panes?: readonly PaneDeclaration[]
    readonly commands?: readonly CommandDeclaration[]
  }
}
```

### `TabDeclaration`

```ts
interface TabDeclaration {
  readonly id: string                  // "<pluginId>.<local>"
  readonly label: string
  readonly icon?: string               // a lucide name, e.g. "CircleDot"
  readonly order?: number              // built-ins 0–99; plugins default to 100
  readonly when?: TabVisibility
}
```

### `PaneDeclaration`

```ts
interface PaneDeclaration {
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly slot: "right" | "bottom"
  readonly defaultSize?: number
}
```

### `CommandDeclaration`

```ts
interface CommandDeclaration {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly icon?: string
}
```

### `ActivationEvent`

```ts
type ActivationEvent =
  | "onStartupFinished"
  | `onCommand:${string}`
  | `onTab:${string}`
  | `repoContains:${string}`
```

`onStartupFinished`, `onCommand:` and `onTab:` are all dispatched.
**`repoContains:` is not** — matching a glob against a session's repo is
implemented by nothing, so declaring it is a load failure rather than a wait that
never ends.

Omit `activationEvents` entirely for a UI-only plugin — no Node process is started.
A disabled plugin is never activated by any event.

### `TabVisibility`

```ts
type TabVisibility = "always" | "hasPr" | "hasWorktree" | "hasIssue"
```

### Type-level helpers

```ts
type TabIdsOf<M>        // union of tab ids a manifest declares
type PaneIdsOf<M>       // union of dock-pane ids a manifest declares
type CommandIdsOf<M>    // union of command ids a manifest declares
type IdOf<M>            // the plugin's own id, as a literal
type ContributionId<M>  // `${IdOf<M>}.${string}`
type Plugin<M>          // { manifest, views, panes }
type Disposable         // { dispose(): void }
```

---

## `@starbase/plugin-sdk/host`

### `Activate` / `Deactivate`

```ts
type Activate = (ctx: HostContext) => void | Promise<void>
type Deactivate = () => void | Promise<void>
```

Export `activate` from your `main` entry. Called when an activation event fires.

### `HostContext`

```ts
interface HostContext {
  readonly pluginId: string
  readonly storage: PluginStorage
  readonly authentication: Authentication
  readonly commands: HostCommands
  readonly events: HostEvents
  readonly exec: (
    command: string,
    args?: readonly string[],
    options?: ExecOptions
  ) => Promise<ExecResult>
  readonly log: Logger
  readonly subscriptions: Disposable[]
}
```

Push `Disposable`s onto `subscriptions` and the host disposes them, in reverse
order, on deactivate.

There is no `ctx.http`. The host half is Node — use global `fetch`. `exec` is
preferred over `node:child_process` so the host can observe it and, in an
untrusted repo, refuse it.

### `Authentication`

```ts
interface Authentication {
  // Prompts, and REJECTS if the operator declines.
  getSession(providerId: string, scopes: readonly string[]): Promise<AuthSession>
  // Does not prompt; resolves undefined when there is no existing grant.
  getSession(
    providerId: string,
    scopes: readonly string[],
    options: { readonly createIfNone: false }
  ): Promise<AuthSession | undefined>
  registerProvider(provider: AuthProvider): Disposable
}
```

**There is no manifest permission for credentials.** Ask here; the operator
consents once per plugin and scope set, and can revoke in Settings. Declining
rejects, mirroring VS Code; pass `{ createIfNone: false }` to ask without
prompting and get `undefined` when there is no grant.

`registerProvider` lets your plugin *be* a provider (a self-hosted GitLab, an
internal tool), which other plugins then request sessions from through the same
`getSession` call.

### `AuthSession`

```ts
interface AuthSession {
  /** `"<pluginId>:<providerId>"`. Pass to `AuthProvider.removeSession`. */
  readonly id: string
  readonly providerId: string
  readonly accessToken: string
  readonly account?: string
  readonly scopes: readonly string[]
  /** ISO-8601. When the operator granted this access. */
  readonly grantedAt: string
}
```

Stays in the extension host. There is no route to send it to your UI half.

### `HostCommands`

```ts
interface HostCommands {
  register(id: string, handler: (arg: unknown) => Promise<unknown>): Disposable
}
```

The id must be one your manifest declares in `contributes.commands`.

### `HostEvents` / `HostEvent`

```ts
interface HostEvents {
  /** @returns a Disposable that removes the handler. Push it onto `subscriptions`. */
  on(handler: (event: HostEvent) => void): Disposable
}

type HostEvent =
  | { type: "session-opened";         session: SessionSnapshot }
  | { type: "session-closed";         sessionId: string }          // only the id survives
  | { type: "active-session-changed"; session: SessionSnapshot | null }
  | { type: "repo-trusted";           repo: string }               // un-gates restricted contributions

type HostEventType = HostEvent["type"]
```

```ts
export const activate = (ctx: HostContext) => {
  ctx.subscriptions.push(
    ctx.events.on((event) => {
      if (event.type === "active-session-changed") ctx.log.info(`now: ${event.session?.repo}`)
    })
  )
}
```

### `Logger`

```ts
interface Logger {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}
```

Lines are tagged with your plugin id and land in Starbase's plugin log. See
[`docs/plugins/debugging.md`](../../docs/plugins/debugging.md) for where to read
them — a logger whose output you cannot find is not a logger.

### `ExecOptions` / `ExecResult`

```ts
// `cwd` defaults to the HOST PROCESS's directory, not a repo. Pass it
// explicitly for anything repo-shaped — your tab has `session.worktreePath`.
interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
}
interface ExecResult {
  stdout: string
  stderr: string
  /**
   * `code`, NOT `exitCode`. This page said `exitCode` for a while; anyone who
   * copied it got `undefined`, which is falsy, so `if (result.exitCode !== 0)`
   * never fired and every failed command looked like a success.
   */
  code: number
}
```

Output is capped at 8 MiB **per stream** and truncated rather than dropped, so a
runaway process cannot exhaust memory and a chatty `stdout` cannot starve the
`stderr` that explains the failure. `stdout` gains a trailing
`… output truncated` when the cap was hit.

---

## `@starbase/plugin-sdk/vite`

### `starbasePluginBuild`

```ts
function starbasePluginBuild(options: {
  /** Your UI entry, e.g. `src/ui.tsx`. Emitted as `ui.js`. */
  entry?: string
  /** Clearer alias for `entry`. Use this one when the plugin has both halves. */
  ui?: string
  /** Your host entry, e.g. `src/main.ts`. Emitted as `main.js`. */
  main?: string
  /** Defaults to `dist`. Must match the paths in your manifest. */
  outDir?: string
}): BuildOptions
```

A Vite `build` config with the correct externals. Use it — bundling React breaks
your plugin for anyone who installs a second one.

**If your manifest declares `main`, you must pass `main` here.** Omitting it
builds a plugin that loads fine and then fails at its first activation event,
because the file the manifest promises was never emitted.

### `STARBASE_EXTERNALS`

```ts
const STARBASE_EXTERNALS: readonly [
  "react", "react-dom", "react/jsx-runtime",
  "react/jsx-dev-runtime", "@starbase/plugin-sdk", "@starbase/plugin-sdk/ui"
]
```

Specifiers Starbase provides at runtime. Never bundle these.

### Your own dependencies

Everything *not* in that list is **bundled into your output**, and that is the
only way it can work: `install:local` copies `starbase.plugin.json` and `dist`
and nothing else, so there is no `node_modules` beside your plugin at runtime.

Import `octokit` in your host half and Vite inlines it — fine. Mark it external
in your own Vite config and you ship a plugin that throws `Cannot find module` at
its first activation, on a machine that is not yours.

---

## `@starbase/plugin-sdk/ui` — the themed kit

Starbase's own components, themed by the active colour theme, re-exported for
plugins. Use these before writing your own: they are how a plugin looks like part
of the app rather than a webpage inside it, and they are already externalised so
they cost your bundle nothing.

| Export | What it is |
|---|---|
| `Avatar` | A user avatar with initials fallback |
| `Badge` | A small count or status chip |
| `Callout` | A bordered note block |
| `Card` | A panel container |
| `CodeChip` | Inline monospace token |
| `Input` / `SearchInput` | Themed text inputs |
| `IssueLabelChip` | A GitHub label, tinted from its own hex colour |
| `Kbd` | A keyboard-key glyph |
| `Markdown` | The app's markdown renderer, with syntax highlighting |
| `Pill` | A rounded label |
| `SegmentedControl` | A small tab-like switch |
| `Spinner` | The app's loading indicator |
| `StatusDot` | A coloured state dot |
| `Toggle` | The app's switch |
| `cn` | `clsx` + tailwind-merge; use for conditional classes |
| `atLeast` / `useWidthTier` | Responsive width tiers, so a pane can adapt |
| `relativeTime` | "3 minutes ago" formatting |
| `githubAvatarUrl` | Build a GitHub avatar URL from a login |

```ts
import { Card, Markdown, Spinner, cn } from "@starbase/plugin-sdk/ui"
```
