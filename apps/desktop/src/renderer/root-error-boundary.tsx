import { Component, type ErrorInfo, type ReactNode } from "react"
import { CrashScreen } from "@jingler/ui"
import { rpc } from "./rpc-client.js"

/**
 * The LAST line of defence above `<App/>`.
 *
 * Without a boundary here, one uncaught error in any render path unmounts the
 * entire React root: the window keeps its themed background and nothing else —
 * a black screen over a perfectly healthy renderer process, with the only
 * evidence in a DevTools console nobody has open. That is exactly how a
 * blocked-WASM CompileError during agent streaming presented in the field.
 *
 * This is deliberately NOT a recovery mechanism — no retry loops, no state
 * resurrection. It renders the `CrashScreen` card, logs the componentStack,
 * and offers reload, copy-details and open-logs. Feature-level boundaries can and
 * should catch earlier; this one only exists so the failure is never silent.
 */
interface RootErrorBoundaryState {
  readonly error: Error | null
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[root-error-boundary] the app tree crashed", error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <CrashScreen
        details={this.state.error.stack ?? String(this.state.error)}
        onReload={() => window.location.reload()}
        onOpenLogs={() => void rpc.appRevealLogs().catch(() => {})}
      />
    )
  }
}
