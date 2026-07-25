# `@starbase/plugin-sdk` — API digest

Every export, with its signature and one line of purpose. For the narrative
version see `AGENTS.md`; for the manifest's validated shape see
`starbase.plugin.schema.json`.

Two entrypoints, deliberately separate so a host-only plugin never pulls React
into Node and a UI-only plugin never pulls Node types into the browser:

| Import from | Runs in | Use for |
|---|---|---|
| `@starbase/plugin-sdk` | Starbase's renderer | tabs, panes, React components |
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
  impl: { views: { [K in TabIdsOf<M>]: ComponentType<TabProps> } }
): Plugin<M>
```

Binds view components to declared tabs. Missing a declared tab is a compile
error; supplying an undeclared one is a compile error. The return value is what
your UI module must `export default`.

---

## `@starbase/plugin-sdk` — hooks

All throw if called outside a plugin view.

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
}
```

`invoke` is the only route from a plugin's UI to anything outside the renderer.

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

Omit entirely for a UI-only plugin — no Node process is started.

### `TabVisibility`

```ts
type TabVisibility = "always" | "hasPr" | "hasWorktree" | "hasIssue"
```

### Type-level helpers

```ts
type TabIdsOf<M>        // union of tab ids a manifest declares
type CommandIdsOf<M>    // union of command ids a manifest declares
type IdOf<M>            // the plugin's own id, as a literal
type ContributionId<M>  // `${IdOf<M>}.${string}`
type Plugin<M>          // { manifest, views }
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
  getSession(
    providerId: string,
    scopes: string[],
    opts?: { createIfNone?: boolean }
  ): Promise<AuthSession | null>
  registerProvider(provider: AuthProvider): Disposable
}
```

**There is no manifest permission for credentials.** Ask here; the operator
consents once per plugin and scope set, and can revoke in Settings. `null` means
declined — degrade, do not throw.

`registerProvider` lets your plugin *be* a provider (a self-hosted GitLab, an
internal tool), which other plugins then request sessions from through the same
`getSession` call.

### `AuthSession`

```ts
interface AuthSession {
  readonly accessToken: string
  readonly account?: string
  readonly scopes: readonly string[]
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

### `ExecOptions` / `ExecResult`

```ts
interface ExecOptions { cwd?: string; env?: Record<string, string> }
interface ExecResult { stdout: string; stderr: string; exitCode: number }
```

---

## `@starbase/plugin-sdk/vite`

### `starbasePluginBuild`

```ts
function starbasePluginBuild(options: { entry: string; outDir?: string }): BuildOptions
```

A Vite `build` config with the correct externals. Use it — bundling React breaks
your plugin for anyone who installs a second one.

### `STARBASE_EXTERNALS`

```ts
const STARBASE_EXTERNALS: readonly [
  "react", "react-dom", "react/jsx-runtime",
  "react/jsx-dev-runtime", "@starbase/plugin-sdk"
]
```

Specifiers Starbase provides at runtime. Never bundle these.
