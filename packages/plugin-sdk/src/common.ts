/**
 * The handful of shapes both halves of a plugin share.
 *
 * ## Why this module has no React and no `effect`
 *
 * A plugin has two halves that run in different realms: the UI half is an ES
 * module in the renderer, the host half is Node in the extension host. The two
 * import from different SDK entrypoints (`.` and `./host`) precisely so a
 * host-only plugin never pulls React into a Node process and a UI-only plugin
 * never pulls Node types into the browser. But a few nouns — a session, a
 * key/value store, a disposable subscription — are spoken on both sides, and
 * duplicating them would let the two drift. They live here, in a module that
 * imports nothing, so either entrypoint can re-export them without dragging its
 * sibling's dependencies along.
 */

/**
 * A read-only snapshot of the session a plugin is looking at.
 *
 * ## Why this is not Starbase's internal `Session`
 *
 * Starbase's own `Session` type carries ~25 fields — cost meters, token
 * accounting, chat arrays, worktree bookkeeping — most of which are churn a
 * plugin must never couple to. `SessionSnapshot` is the deliberately small,
 * deliberately stable subset a third-party tab can build on: the identity of
 * the repo/branch/PR it is decorating, and nothing that would break a plugin
 * every time Starbase reshapes its internals. Fields are added here only when a
 * plugin genuinely cannot do its job without them.
 *
 * @example
 * ```ts
 * function title(session: SessionSnapshot): string {
 *   return session.prNumber != null
 *     ? `${session.repo}#${session.prNumber}`
 *     : `${session.repo}@${session.branch}`
 * }
 * ```
 *
 * @see HostEvent — carries a `SessionSnapshot` as sessions open and close.
 * @see TabProps — a tab component receives the current snapshot as a prop.
 */
export interface SessionSnapshot {
  /** Stable id for the session, unique for the lifetime of the window. */
  readonly id: string
  /** `owner/repo`, e.g. `"trigify/api"`. */
  readonly repo: string
  /** The git branch checked out in this session's worktree. */
  readonly branch: string
  /** The session's display title, as shown in the sidebar. */
  readonly title: string
  /** Which local agent is driving the session. */
  readonly cli: "claude" | "codex" | "cursor" | "opencode" | "starbase"
  /** The linked pull-request number, or `null` when the session has no PR. */
  readonly prNumber: number | null
  /** The linked GitHub issue number, when one drove the session. */
  readonly issueNumber?: number
  /** Absolute path to the session's isolated git worktree, when one exists. */
  readonly worktreePath?: string
}

/**
 * A per-plugin key/value store, scoped and persisted by the host.
 *
 * ## Why the host owns the bytes
 *
 * The store is namespaced to the plugin and survives restarts, but the plugin
 * never sees where it lands on disk — that is the host's call, so honest plugins
 * cannot collide and none needs to know the layout.
 *
 * Namespacing is not isolation: all host halves share one process, so this stops
 * accidents rather than adversaries. `docs/plugins/permissions-and-trust.md` is
 * explicit about which boundaries are real. The same
 * interface is handed to both halves ({@link HostContext.storage} and
 * {@link usePluginStorage}); a value written by the host half is readable by the
 * UI half and vice versa, because both resolve to the one store the host keeps.
 *
 * Every method is async: the UI half's calls cross the IPC boundary to the host,
 * so pretending they are synchronous would be a lie the first slow disk exposes.
 *
 * @example
 * ```ts
 * const store: PluginStorage = usePluginStorage()
 * await store.set("lastSync", Date.now())
 * const last = await store.get<number>("lastSync") // number | undefined
 * ```
 *
 * @see HostContext.storage — the host half's handle to the same store.
 * @see usePluginStorage — the UI half's hook returning this interface.
 */
export interface PluginStorage {
  /**
   * Read a value, or `undefined` if the key was never set.
   * @typeParam T - the caller's expectation of the stored shape; unchecked at
   * runtime, so treat a returned value as untrusted until you validate it.
   */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Write a value, replacing any existing one under `key`. */
  set<T = unknown>(key: string, value: T): Promise<void>
  /** Remove a key. A no-op if it was not set. */
  delete(key: string): Promise<void>
  /** Every key currently set for this plugin. */
  keys(): Promise<readonly string[]>
}

/**
 * A handle that undoes a registration or subscription when disposed.
 *
 * Returned by everything on the host side that hooks into the app —
 * {@link HostCommands.register}, {@link HostEvents.on},
 * {@link Authentication.registerProvider}. Push it onto
 * {@link HostContext.subscriptions} and the host disposes it for you when the
 * plugin deactivates; hold it yourself to tear a single subscription down early.
 *
 * The name and shape mirror VS Code's `Disposable` on purpose — a plugin author
 * who has written an extension already reaches for `context.subscriptions.push`.
 *
 * @example
 * ```ts
 * const sub: Disposable = ctx.events.on((event) => {
 *   if (event.type === "session-closed") flush(event.sessionId)
 * })
 * ctx.subscriptions.push(sub) // torn down automatically on deactivate
 * ```
 */
export interface Disposable {
  /** Release whatever this handle holds. Safe to call more than once. */
  dispose(): void
}
