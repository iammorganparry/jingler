/**
 * Fires `onTab:<id>` when a plugin's tab is actually shown.
 *
 * ## Why mounting is the right trigger
 *
 * `SessionPane` renders only the ACTIVE contribution, so a plugin tab's body
 * mounts exactly when the operator switches to it and unmounts when they leave.
 * That makes mount a precise `onTab` signal, and it needs no tab-change callback
 * threaded from `packages/ui` down into the desktop app — which would put
 * plugin-activation knowledge in a package that has no business knowing about the
 * extension host.
 *
 * ## Why this is not just left to `invoke`
 *
 * Before this, `activate()` was reachable only from `invoke()`. So `onTab` looked
 * like it worked, because a plugin tab's first render usually calls
 * `host.invoke(...)` and activation happened on the way past. A tab that renders
 * from `session` alone, or one whose `activate` sets up subscriptions it expects
 * to be running before the first command, got nothing — and the manifest said it
 * would. Depending on a side effect of an unrelated call is not the same as
 * dispatching the event.
 *
 * ## Failure policy
 *
 * Swallowed after logging. Activation failures already reach the operator through
 * `onActivationFailed` → the plugin's row in Settings, and a rejected promise here
 * would be an unhandled rejection inside a render tree. A plugin whose host half
 * will not start still shows its tab; whether the tab then works is between it and
 * its author.
 */
import { useEffect, type ReactNode } from "react"
import { rpc } from "./rpc-client.js"

interface Props {
  readonly pluginId: string
  /**
   * Whether this plugin declared `onTab:<thisTabId>`.
   *
   * Passed in rather than derived here so the manifest lookup happens once in the
   * registry, and so a plugin that did NOT declare the event costs nothing — it
   * gets no RPC at all, which keeps lazy activation genuinely lazy.
   */
  readonly shouldActivate: boolean
  readonly children: ReactNode
}

export function PluginActivateOnMount({ pluginId, shouldActivate, children }: Props) {
  useEffect(() => {
    if (!shouldActivate) return
    // Idempotent on the main side: the runtime joins an in-flight activation and
    // returns immediately for one already done, so switching between two plugin
    // tabs repeatedly does not restart anything.
    void rpc.pluginsActivate(pluginId).catch((cause: unknown) => {
      console.error(`[plugin:${pluginId}] onTab activation failed:`, cause)
    })
  }, [pluginId, shouldActivate])

  return children
}
