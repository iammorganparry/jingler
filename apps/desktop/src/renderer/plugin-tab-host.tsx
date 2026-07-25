/**
 * The blast wall around a plugin's rendered body.
 *
 * A plugin's component runs inside the app's React tree with the app's React.
 * An uncaught throw during render unwinds to the nearest boundary, and without
 * one here the nearest boundary is the root — so a single plugin with a typo
 * would blank the entire window, sessions and all.
 *
 * The failure card is deliberately plain and names the plugin. The operator's
 * next move is to disable that plugin or tell its author, and both need the id;
 * a generic "something went wrong" would leave them guessing which of six
 * installed plugins to suspect.
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import type { Session } from "@starbase/core"
import { PluginViewProvider } from "@starbase/plugin-sdk"
import { pluginBridge } from "./plugin-bridge.js"
import { toSessionSnapshot } from "./plugin-loader.js"

interface Props {
  readonly pluginId: string
  /** The internal session. Narrowed to a `SessionSnapshot` before it is exposed. */
  readonly session: Session
  readonly children: ReactNode
}

interface State {
  readonly message: string | null
}

export class PluginTabHost extends Component<Props, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Logged with the plugin id attached: a stack trace from a plugin bundle is
    // otherwise unattributable, since the frames name files the app has never
    // heard of.
    console.error(`[plugin:${this.props.pluginId}] crashed while rendering`, error, info)
  }

  /**
   * Clear the error when the operator switches back to the tab.
   *
   * Without this the card is sticky for the life of the mount: a plugin that
   * failed once because a request timed out would stay broken until the app
   * restarted, even after the plugin itself was fixed and hot-reloaded.
   */
  override componentDidUpdate(prev: Props): void {
    if (prev.pluginId !== this.props.pluginId && this.state.message) {
      this.setState({ message: null })
    }
  }

  override render(): ReactNode {
    if (this.state.message === null) {
      // The provider sits INSIDE the boundary, so a throw while building the
      // context is caught by the same card as a throw in the plugin's own
      // render. It is also the single place an internal `Session` is narrowed
      // to the `SessionSnapshot` the SDK documents — a plugin never sees the
      // other ~20 fields, which is what keeps them free to change.
      return (
        <PluginViewProvider
          value={{
            pluginId: this.props.pluginId,
            session: toSessionSnapshot(this.props.session),
            bridge: pluginBridge(this.props.pluginId)
          }}
        >
          {this.props.children}
        </PluginViewProvider>
      )
    }

    return (
      <div
        data-testid={`plugin-error-${this.props.pluginId}`}
        className="flex flex-1 flex-col items-center justify-center gap-3 bg-editor px-8 text-dim"
      >
        <TriangleAlert size={34} className="text-yellow" strokeWidth={1.5} />
        <div className="text-[15px] font-semibold text-text">
          The “{this.props.pluginId}” plugin stopped working
        </div>
        <div className="max-w-[420px] text-center font-mono text-[11.5px] leading-[1.6] text-dim">
          {this.state.message}
        </div>
        <div className="max-w-[420px] text-center text-[12.5px] leading-[1.6]">
          Other tabs are unaffected. You can disable this plugin in Settings ›
          Plugins.
        </div>
      </div>
    )
  }
}
