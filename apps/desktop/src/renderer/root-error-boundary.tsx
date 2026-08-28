import { Component, type ErrorInfo, type ReactNode } from "react"

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
 * resurrection. It renders a plain-HTML error card (theme tokens with
 * hard-coded fallbacks, in case the crash was the theme system itself), logs
 * the componentStack, and offers a reload. Feature-level boundaries can and
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
      <div
        role="alert"
        style={{
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--sb-canvas, #141414)",
          color: "var(--sb-text-body, #dedada)",
          fontFamily: "system-ui, sans-serif"
        }}
      >
        <div style={{ maxWidth: 560, padding: 24 }}>
          <h1 style={{ fontSize: 16, marginBottom: 8 }}>Jingler hit an error it could not draw past</h1>
          <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>
            The app process is fine and your sessions keep running in the background — only this
            window's UI crashed. Reload to reattach.
          </p>
          <pre
            style={{
              fontSize: 11.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              background: "var(--sb-sunken, #101010)",
              padding: 12,
              borderRadius: 8,
              marginBottom: 16,
              maxHeight: 240,
              overflow: "auto"
            }}
          >
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              fontSize: 13,
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid var(--sb-line, #333)",
              background: "var(--sb-panel, #1c1c1c)",
              color: "inherit",
              cursor: "pointer"
            }}
          >
            Reload window
          </button>
        </div>
      </div>
    )
  }
}
