/**
 * `@jingler/plugin-sdk/host` — the extension-host half of a plugin.
 *
 * Import from here in the module your manifest names as `main`. It runs in
 * Node, inside Jingler's extension host, and it is where anything touching the
 * network, a CLI or credentials belongs — the renderer's CSP means a plugin's UI
 * half cannot reach the outside world however much code it runs.
 *
 * Separate from the root entrypoint so a host-only plugin never pulls React into
 * a Node process, and a UI-only plugin never pulls Node types into the browser.
 *
 * @example
 * ```ts
 * import type { Activate } from "@jingler/plugin-sdk/host"
 *
 * export const activate: Activate = async (ctx) => {
 *   // No manifest flag grants GitHub access — the plugin asks, and the
 *   // operator consents once for this plugin and these scopes.
 *   const session = await ctx.authentication.getSession("github", [
 *     "pull_requests:read",
 *     "repository:acme/widgets",
 *   ])
 *   if (!session) return // declined; degrade quietly rather than throwing
 *
 *   ctx.subscriptions.push(
 *     ctx.commands.register("linear.sync", async () => {
 *       const response = await fetch(`${session.apiBaseUrl}/repos/acme/widgets/pulls`, {
 *         headers: { authorization: `Bearer ${session.accessToken}` },
 *       })
 *       return response.json()
 *     })
 *   )
 * }
 * ```
 */
export type {
  Activate,
  Deactivate,
  HostContext,
  HostCommands,
  HostEvent,
  HostEventType,
  HostEvents,
  ExecOptions,
  ExecResult,
  AuthSession,
  Authentication,
  AuthProvider,
  Logger
} from "./host-context.js"

export type { Disposable, PluginStorage, SessionSnapshot } from "./common.js"
