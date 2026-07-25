/**
 * The extension-host half of a plugin — everything `activate()` is handed.
 *
 * ## Where this code runs, and why the surface looks like this
 *
 * The host half is Node, in Starbase's extension host, with the same reach any
 * Node process has: it can spawn `gh`, read the worktree, open sockets. It is
 * NOT a sandbox (see `packages/core/src/plugin.ts` — "What this file is NOT").
 * What IS enforced lives at the two boundaries this file draws:
 *
 * 1. **Lazy activation.** A plugin is a manifest entry until one of its
 *    declared `activationEvents` fires. {@link Activate} is not called before
 *    then, so ten installed plugins cost nothing until the operator reaches for
 *    one.
 * 2. **Consent before credentials.** The host never hands a plugin a token it
 *    did not ask for. {@link Authentication.getSession} is the only door to a
 *    real account, and it prompts the operator — naming this plugin, this
 *    provider, these scopes — every time the ask widens.
 *
 * This module imports no React and no `effect`: it is the contract for a Node
 * entry, and the renderer half lives behind the package's `.` entrypoint.
 *
 * @see HostContext — the object passed to {@link Activate}.
 * @see Authentication — the consent-gated door to accounts.
 */
import type { Disposable, PluginStorage, SessionSnapshot } from "./common.js"

export type { Disposable, PluginStorage, SessionSnapshot } from "./common.js"

// ── The entry points ─────────────────────────────────────────────────────────

/**
 * A plugin's host entry — the default export of its `main` module.
 *
 * Called once, the first time one of the plugin's `activationEvents` fires, with
 * a live {@link HostContext}. Return a {@link Deactivate} to run teardown, or
 * push {@link Disposable}s onto {@link HostContext.subscriptions} and let the
 * host tear them down for you. May be async — the host awaits it before
 * dispatching the command or opening the tab that triggered activation.
 *
 * An `activate` that throws marks the plugin's host half dead and surfaces the
 * error in Settings; its UI half keeps rendering. That split is intentional: a
 * broken backend must not blank a tab the operator can still read.
 *
 * @example
 * ```ts
 * import type { Activate } from "@starbase/plugin-sdk/host"
 *
 * export const activate: Activate = (ctx) => {
 *   const sub = ctx.commands.register("linear.refresh", () => refresh(ctx))
 *   ctx.subscriptions.push(sub)
 *   return () => ctx.log.info("linear plugin deactivated")
 * }
 * ```
 *
 * @see Deactivate - the teardown callback this may return.
 * @see HostContext - the capabilities handed in.
 */
export type Activate = (
  context: HostContext
) => void | Deactivate | Promise<void | Deactivate>

/**
 * Teardown for a plugin's host half — the optional return of {@link Activate}.
 *
 * Runs when the plugin is disabled, uninstalled, or the window closes. Anything
 * pushed onto {@link HostContext.subscriptions} is already disposed by the time
 * this is called, so reserve it for teardown the host cannot know about — a
 * flushed cache, a closed socket a subscription did not own.
 *
 * @example
 * ```ts
 * const deactivate: Deactivate = async () => {
 *   await flushPendingWrites()
 * }
 * ```
 */
export type Deactivate = () => void | Promise<void>

// ── The context ──────────────────────────────────────────────────────────────

/**
 * Everything a plugin's host half can reach, handed to {@link Activate}.
 *
 * Capabilities are properties, not free imports, for one reason: a plugin's
 * reach is exactly what the host chose to put on this object, and the host can
 * scope, log or revoke any of it. `import { exec } from "node:child_process"`
 * is still possible — this is not a sandbox — but the supported, observable
 * path is `ctx.exec`, and the docs steer authors to it.
 *
 * @example
 * ```ts
 * export const activate: Activate = async (ctx) => {
 *   ctx.log.info(`activating for plugin ${ctx.pluginId}`)
 *   const gh = await ctx.authentication.getSession("github", ["repo"])
 *   const me = await ctx.exec("gh", ["api", "user"], {
 *     env: { GH_TOKEN: gh.accessToken },
 *   })
 *   ctx.log.info(me.stdout)
 * }
 * ```
 *
 * @see Authentication - `ctx.authentication`, the consent-gated account door.
 * @see HostCommands - `ctx.commands`, where command handlers are registered.
 * @see HostEvents - `ctx.events`, the session-lifecycle stream.
 */
export interface HostContext {
  /** The id of the plugin this context belongs to, as declared in its manifest. */
  readonly pluginId: string
  /**
   * This plugin's persistent, namespaced key/value store. The same bytes the
   * UI half sees through {@link usePluginStorage}.
   */
  readonly storage: PluginStorage
  /** The consent-gated door to accounts, and where a plugin registers a provider. */
  readonly authentication: Authentication
  /** Register handlers for the commands the manifest contributes. */
  readonly commands: HostCommands
  /** Subscribe to session-lifecycle events. */
  readonly events: HostEvents
  /**
   * Run a subprocess and await its result. Prefer this over `node:child_process`
   * so the host can observe and, in an untrusted repo, refuse it.
   *
   * @returns the process's exit code and captured output — see {@link ExecResult}.
   * @throws if the executable cannot be spawned at all (not found, not
   * permitted). A process that runs and exits non-zero resolves with that
   * `code`; it does not throw.
   */
  readonly exec: (
    command: string,
    args?: readonly string[],
    options?: ExecOptions
  ) => Promise<ExecResult>
  /** A logger whose output lands in Starbase's plugin log, tagged with `pluginId`. */
  readonly log: Logger
  /**
   * Push {@link Disposable}s here and the host disposes them, in reverse order,
   * when the plugin deactivates. The idiomatic home for every registration.
   */
  readonly subscriptions: Disposable[]
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Where a plugin backs the commands its manifest promised.
 *
 * A manifest's `contributes.commands` is only the palette entry; this is the
 * behaviour behind it. Registering an id the manifest did not contribute, or
 * leaving a contributed command unregistered, is the plugin's bug to catch —
 * the manifest schema guarantees the id is namespaced, not that a handler exists.
 *
 * @see CommandContribution (in `@starbase/core`) — the manifest side of a command.
 */
export interface HostCommands {
  /**
   * Bind a handler to a contributed command id. The handler's return value is
   * sent back to whoever dispatched the command (a palette entry, a UI
   * {@link useCommand} call, a keybinding).
   *
   * @param commandId - a `<pluginId>.<local>` id this plugin contributes.
   * @param handler - invoked with the dispatcher's argument, if any.
   * @returns a {@link Disposable} that unregisters the handler.
   *
   * @example
   * ```ts
   * const sub = ctx.commands.register("linear.refresh", async (input) => {
   *   const issues = await fetchIssues()
   *   return issues.length
   * })
   * ctx.subscriptions.push(sub)
   * ```
   */
  register(
    commandId: string,
    handler: (input?: unknown) => unknown | Promise<unknown>
  ): Disposable
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * A session-lifecycle event, as a discriminated union keyed on `type`.
 *
 * ## Why a discriminated union
 *
 * A single `type` field the compiler can narrow on means a `switch (event.type)`
 * is exhaustive-checkable and each arm sees exactly the fields that case
 * carries — no `event.sessionId!` on a case that has a whole `session`, no
 * optional-everything bag that models states that cannot occur. Add a case and
 * every unhandled `switch` becomes a type error, which is the point.
 *
 * @example
 * ```ts
 * ctx.events.on((event) => {
 *   switch (event.type) {
 *     case "session-opened":
 *     case "active-session-changed":
 *       // `event.session` is in scope and typed
 *       break
 *     case "session-closed":
 *       // only `event.sessionId` here
 *       flush(event.sessionId)
 *       break
 *     case "repo-trusted":
 *       break
 *   }
 * })
 * ```
 *
 * @see HostEvents.on — how a handler subscribes.
 */
export type HostEvent =
  | {
      /** A session was opened. `session` is the freshly opened snapshot. */
      readonly type: "session-opened"
      readonly session: SessionSnapshot
    }
  | {
      /** A session was closed. Only its id survives the close. */
      readonly type: "session-closed"
      readonly sessionId: string
    }
  | {
      /** The operator brought a different session to the foreground, or none. */
      readonly type: "active-session-changed"
      readonly session: SessionSnapshot | null
    }
  | {
      /** The operator granted trust to a repo, un-gating restricted contributions. */
      readonly type: "repo-trusted"
      readonly repo: string
    }

/** The `type` tag of a {@link HostEvent} — handy for filtering by kind. */
export type HostEventType = HostEvent["type"]

/** Subscribe to the {@link HostEvent} stream. */
export interface HostEvents {
  /**
   * Register a handler for every {@link HostEvent}.
   * @returns a {@link Disposable} that removes the handler.
   */
  on(handler: (event: HostEvent) => void): Disposable
}

// ── exec ─────────────────────────────────────────────────────────────────────

/** Options for {@link HostContext.exec}. */
export interface ExecOptions {
  /** Working directory. Defaults to the active session's worktree. */
  readonly cwd?: string
  /** Extra environment for the child, merged over the host's own. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to the child's stdin, then closed. */
  readonly input?: string
  /** Kill the child after this many milliseconds and reject. */
  readonly timeoutMs?: number
}

/**
 * The result of a {@link HostContext.exec} call.
 *
 * `code` is the process's own exit status: a command that ran and failed
 * resolves here with a non-zero `code`, it does not throw. Only a process that
 * could not be started at all rejects. This split lets `const { code } = await
 * ctx.exec(...)` handle "it failed" without a `try`/`catch`, keeping the throw
 * for the genuinely exceptional "it never ran".
 *
 * @example
 * ```ts
 * const { code, stdout } = await ctx.exec("git", ["rev-parse", "HEAD"])
 * if (code === 0) ctx.log.info(`HEAD is ${stdout.trim()}`)
 * ```
 */
export interface ExecResult {
  /** The child's exit code. `0` conventionally means success. */
  readonly code: number
  /** Everything the child wrote to stdout, decoded as UTF-8. */
  readonly stdout: string
  /** Everything the child wrote to stderr, decoded as UTF-8. */
  readonly stderr: string
}

// ── Authentication ───────────────────────────────────────────────────────────

/**
 * A granted authentication session — **with** the access token.
 *
 * ## Why this differs from core's `AuthSessionInfo`
 *
 * `@starbase/core`'s `AuthSessionInfo` deliberately has no token field: it is
 * what the *renderer* may know, so a log line or crash report there cannot leak
 * a secret. This type is the host-side counterpart, and it *does* carry the
 * token, because the host is where credentialed calls are actually made. Keep
 * `accessToken` inside the host half — never return it across the RPC boundary
 * to the UI, or you have reopened the hole core closed.
 *
 * @see AuthSessionInfo (in `@starbase/core`) — the tokenless, renderer-visible twin.
 * @see Authentication.getSession — how one is obtained.
 */
export interface AuthSession {
  /** Stable id for this session, for {@link AuthProvider.removeSession}. */
  readonly id: string
  /** The provider that issued it, e.g. `"github"`. */
  readonly providerId: string
  /** A human-readable account label, e.g. a GitHub login. */
  readonly account?: string
  /** The scopes actually granted, which may exceed the scopes requested. */
  readonly scopes: readonly string[]
  /** The secret. Host-only — never send it to the renderer. */
  readonly accessToken: string
  /** ISO-8601 timestamp of when consent was granted. */
  readonly grantedAt: string
}

/**
 * The consent-gated door to accounts — what a coarse `permissions` array could
 * never express.
 *
 * Identity is the triple (this plugin, a provider, a set of scopes). The first
 * time a plugin asks, the operator sees a prompt naming all three and grants or
 * refuses. Widening the scopes later is a *new* ask and prompts again, so a
 * plugin granted `["repo"]` cannot quietly escalate to `["admin:org"]`. Grants
 * are revocable from Settings at any time.
 *
 * The official GitHub plugin uses exactly this call; it holds no privilege a
 * third-party plugin could not also request. That symmetry is the whole design.
 *
 * @see AuthSession — what a successful grant returns.
 * @see AuthProvider — implement this to *offer* a provider others can call.
 */
export interface Authentication {
  /**
   * Ask for a session on `providerId` with `scopes`, prompting the operator for
   * consent when this exact ask has not been granted before.
   *
   * @param providerId - a provider id, built-in (`"github"`) or contributed by a
   * plugin's {@link AuthProvider}.
   * @param scopes - the scopes to request; shown verbatim in the consent prompt.
   * @param options - `createIfNone: false` turns "no existing grant" into a
   * resolved `undefined` instead of a prompt — for a background check that must
   * not interrupt the operator.
   * @returns the granted {@link AuthSession}, token included.
   * @throws if the operator refuses, or the provider id is unknown.
   *
   * @example
   * ```ts
   * // Interactive: prompts on first use, reuses the grant after.
   * const gh = await ctx.authentication.getSession("github", ["repo"])
   *
   * // Silent: null when there is no grant yet, never prompts.
   * const maybe = await ctx.authentication.getSession("github", ["repo"], {
   *   createIfNone: false,
   * })
   * ```
   */
  getSession(
    providerId: string,
    scopes: readonly string[]
  ): Promise<AuthSession>
  getSession(
    providerId: string,
    scopes: readonly string[],
    options: { readonly createIfNone: false }
  ): Promise<AuthSession | undefined>
  getSession(
    providerId: string,
    scopes: readonly string[],
    options: { readonly createIfNone: true }
  ): Promise<AuthSession>
  /**
   * Register the {@link AuthProvider} this plugin's manifest declared under
   * `contributes.authenticationProviders`. Declaring a provider the host half
   * never registers is a bug the operator meets at first use; register it in
   * `activate()` so the failure, if any, is a load-time one.
   *
   * @returns a {@link Disposable} that unregisters the provider.
   */
  registerProvider(provider: AuthProvider): Disposable
}

/**
 * An authentication provider a plugin *implements* — how "extend the app with
 * your own apps" reaches past the services Starbase ships knowing about.
 *
 * A self-hosted GitLab, an internal tracker, a corporate SSO: each is a plugin
 * that contributes a provider id in its manifest and implements this interface
 * in its host half. Every *other* plugin can then `getSession(thatId, scopes)`
 * through the identical door it uses for the built-in `"github"` provider — the
 * provider's own plugin holds no special status.
 *
 * @example
 * ```ts
 * const gitlab: AuthProvider = {
 *   id: "acme-gitlab",
 *   label: "Acme GitLab",
 *   getSessions: async () => loadStoredSessions(),
 *   createSession: async (scopes) => runOauthFlow(scopes),
 *   removeSession: async (id) => forget(id),
 * }
 * ctx.subscriptions.push(ctx.authentication.registerProvider(gitlab))
 * ```
 *
 * @see AuthProviderContribution (in `@starbase/core`) — the manifest declaration
 * this backs.
 */
export interface AuthProvider {
  /** The provider id, matching the manifest's `authenticationProviders[].id`. */
  readonly id: string
  /** Human-readable label, shown in consent prompts and Settings. */
  readonly label: string
  /**
   * Existing sessions this provider can vend, optionally filtered to those that
   * satisfy `scopes`. Called by the host to answer a `getSession` without a
   * fresh prompt when a matching grant already exists.
   */
  getSessions(scopes?: readonly string[]): Promise<readonly AuthSession[]>
  /** Run the provider's sign-in for `scopes` and return the new session. */
  createSession(scopes: readonly string[]): Promise<AuthSession>
  /** Revoke and forget the session with this {@link AuthSession.id}. */
  removeSession(sessionId: string): Promise<void>
}

// ── Logging ──────────────────────────────────────────────────────────────────

/** A leveled logger whose lines land in Starbase's plugin log, tagged with the plugin id. */
export interface Logger {
  /** Routine progress. */
  info(message: string, ...args: readonly unknown[]): void
  /** A recoverable oddity worth surfacing. */
  warn(message: string, ...args: readonly unknown[]): void
  /** A failure. Pair it with a thrown error where the failure is fatal to a task. */
  error(message: string, ...args: readonly unknown[]): void
}
