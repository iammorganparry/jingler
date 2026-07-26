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
  /**
   * Changes exactly when the plugin's code does — `id@version` from the catalog.
   * The one signal that means "this is a different plugin build, try again".
   */
  readonly reloadKey: string
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
   * Clear the error when the plugin, its build, or the session actually changes.
   *
   * NOT keyed on `children` identity, which was the previous test and is a trap:
   * `render` builds a fresh element on every pass of the registry's memo, so
   * `prev.children !== this.props.children` is true on every parent re-render.
   * The session pane re-renders constantly (live activity, status ticks), so a
   * plugin that throws deterministically got its error cleared, re-mounted,
   * threw again and logged another `componentDidCatch` — several times a second,
   * forever. The card the operator saw was being torn down and rebuilt under
   * them, and the console filled with the same stack.
   *
   * `reloadKey` is `id@version` from the catalog, which is what a hot reload
   * changes — the case the old comment claimed `children` covered and `pluginId`
   * did not. `session.id` is here because a stale failure should not follow the
   * operator into a different session.
   */
  override componentDidUpdate(prev: Props): void {
    if (this.state.message === null) return
    if (
      prev.pluginId !== this.props.pluginId ||
      prev.reloadKey !== this.props.reloadKey ||
      prev.session.id !== this.props.session.id
    ) {
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
        {/*
          An explicit retry, because the reset rules above are deliberately
          narrow and a plugin can throw on something transient — a field briefly
          undefined during a status tick, a fetch that failed once. The previous
          `children`-keyed reset retried on every render, which self-healed that
          case by accident while making a DETERMINISTIC crash re-mount forever.
          A button is the same recovery without the loop: the operator chooses,
          and a plugin that is genuinely broken shows its card again immediately
          instead of thrashing.
        */}
        <button
          type="button"
          data-testid={`plugin-error-retry-${this.props.pluginId}`}
          onClick={() => this.setState({ message: null })}
          className="rounded border border-line px-2.5 py-1 text-[12px] text-text-body transition-colors hover:border-blue hover:text-text-bright"
        >
          Try again
        </button>
        <div className="max-w-[420px] text-center text-[12.5px] leading-[1.6]">
          Other tabs are unaffected. You can disable this plugin in Settings ›
          Plugins.
        </div>
      </div>
    )
  }
}
