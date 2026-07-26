/**
 * The blast wall and the view context around a plugin's dock pane.
 *
 * `PluginTabHost`'s counterpart. It existed for tabs and nothing existed for
 * panes, while a comment in `plugin-registry.tsx` claimed a pane's "own boundary
 * comes with the pane host in session-split" — where `renderDock` was a bare
 * `<div>`. So there was no boundary anywhere on the pane path: a pane that threw
 * unwound to the root and blanked the whole window, sessions and all, which is
 * precisely what `PluginTabHost` exists to prevent for the other half of the
 * same feature.
 *
 * Panes were also never wrapped in a `PluginViewProvider`, so every SDK hook
 * threw "called outside a Starbase plugin view" inside a pane — in a component
 * the SDK documents as one of the two places hooks work. The pane e2e test could
 * not catch either, because it only read the `session` prop.
 *
 * ## Why this is a separate component rather than a prop on PluginTabHost
 *
 * The session. A tab's is guaranteed; a pane's is `SessionSnapshot | null`,
 * because a dock is mounted once for the window and follows whichever session has
 * focus, including none. Threading a nullable session through the tab host would
 * make every tab's context nullable to serve a case tabs cannot reach, and the
 * failure copy differs too: a broken tab tells the operator other tabs are fine,
 * which is the wrong thing to say about a dock.
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import type { Session } from "@starbase/core"
import { PluginViewProvider } from "@starbase/plugin-sdk"
import { pluginBridge } from "./plugin-bridge.js"
import { toSessionSnapshot } from "./plugin-loader.js"

interface Props {
  readonly pluginId: string
  /** `id@version` from the catalog — see `PluginTabHost`'s `reloadKey`. */
  readonly reloadKey: string
  /** The focused session, or `null` when none is open. */
  readonly session: Session | null
  readonly children: ReactNode
}

interface State {
  readonly message: string | null
}

export class PluginPaneHost extends Component<Props, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] pane crashed while rendering`, error, info)
  }

  /**
   * Clear on a genuinely new plugin build — the same rule, and the same trap
   * avoided, as `PluginTabHost`. See the long note there: keying on `children`
   * identity looks like "the subtree changed" and actually means "anything
   * re-rendered", which turns a deterministic crash into a re-mount loop.
   */
  override componentDidUpdate(prev: Props): void {
    if (this.state.message === null) return
    if (
      prev.pluginId !== this.props.pluginId ||
      prev.reloadKey !== this.props.reloadKey ||
      prev.session?.id !== this.props.session?.id
    ) {
      this.setState({ message: null })
    }
  }

  override render(): ReactNode {
    if (this.state.message === null) {
      // Provider inside the boundary, so a throw while building the context is
      // caught by the same card as a throw in the plugin's own render. Also the
      // one place a pane's internal `Session` is narrowed to the
      // `SessionSnapshot` the SDK documents.
      return (
        <PluginViewProvider
          value={{
            pluginId: this.props.pluginId,
            session: this.props.session ? toSessionSnapshot(this.props.session) : null,
            bridge: pluginBridge(this.props.pluginId)
          }}
        >
          {this.props.children}
        </PluginViewProvider>
      )
    }

    return (
      <div
        data-testid={`plugin-pane-error-${this.props.pluginId}`}
        className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 bg-panel px-4 py-6 text-dim"
      >
        <TriangleAlert size={22} className="text-yellow" strokeWidth={1.5} />
        <div className="text-center text-[12.5px] font-semibold text-text">
          “{this.props.pluginId}” pane stopped working
        </div>
        <div className="max-w-[240px] text-center font-mono text-[10.5px] leading-[1.5] text-dim">
          {this.state.message}
        </div>
        {/* Same explicit retry as the tab host — see the note there. */}
        <button
          type="button"
          data-testid={`plugin-pane-error-retry-${this.props.pluginId}`}
          onClick={() => this.setState({ message: null })}
          className="rounded border border-line px-2 py-0.5 text-[11.5px] text-text-body transition-colors hover:border-blue hover:text-text-bright"
        >
          Try again
        </button>
        <div className="max-w-[240px] text-center text-[11.5px] leading-[1.5]">
          The rest of the app is unaffected. Disable this plugin in Settings ›
          Plugins.
        </div>
      </div>
    )
  }
}
