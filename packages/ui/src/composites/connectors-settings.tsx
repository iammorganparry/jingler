import * as React from "react"
import { ConnectorCenter, type ConnectorCenterProps } from "./connector-center.js"
import { InjectionTargets, type InjectionTargetsProps } from "./injection-targets.js"
import { OpenConnectorSection, type OpenConnectorSectionProps } from "./open-connector-section.js"

/**
 * Settings › Connectors — the ONE MCP surface. It composes the connection setup
 * (`OpenConnectorSection`) and the provider catalog (`ConnectorCenter`) behind a
 * live-connection gate: the catalog is only reachable once a probe against the
 * configured OpenConnector instance actually connects, so the operator sets up the
 * instance before browsing connectors (no "Search 0 providers" dead end).
 */
export interface ConnectorsSettingsProps {
  readonly unifiedMcp?: OpenConnectorSectionProps
  readonly connector?: ConnectorCenterProps
  /** Per-harness injection readout (`OpenConnector.injection`), shown in both views. */
  readonly injection?: InjectionTargetsProps
}

export function ConnectorsSettings({ unifiedMcp, connector, injection }: ConnectorsSettingsProps) {
  const [manage, setManage] = React.useState(false)

  /**
   * Probe exactly once per mount, so a LIVE connection — not merely saved config —
   * gates the catalog.
   *
   * The ref is load-bearing, not defensive. Keying the effect on `test` alone meant
   * any caller handing back a fresh callback each render (React Query's `useMutation`
   * result does exactly that) re-fired the probe on every state change it caused:
   * an unbounded loop that pinned the renderer and left Settings unclickable. The
   * probe is a network call with a 15s timeout — it must fire on open and then only
   * when the operator asks.
   */
  const test = unifiedMcp?.test
  const probed = React.useRef(false)
  React.useEffect(() => {
    if (probed.current || test === undefined) return
    probed.current = true
    test()
  }, [test])

  if (!unifiedMcp) return null

  const connected = unifiedMcp.status?.state === "connected"

  // Not connected (or the operator chose to edit the connection) → setup view. The
  // section surfaces the onboarding banner / endpoint+token fields / Test + the
  // failure reason itself, so this is both the gate and the fix-it screen.
  if (!connected || manage) {
    return (
      <div className="flex flex-col gap-4">
        <OpenConnectorSection {...unifiedMcp} />
        {/* Shown in the setup view too: the per-harness rows are how the operator
            sees an opt-out or a missing token, which is what they came here to fix. */}
        {injection ? <InjectionTargets {...injection} /> : null}
        {connected ? (
          <button
            type="button"
            onClick={() => setManage(false)}
            className="self-start text-[11px] text-blue hover:underline"
          >
            ← Back to connectors
          </button>
        ) : null}
      </div>
    )
  }

  return (
    // `min-h-0 flex-1` so the catalog below can claim the leftover height
    // instead of sitting in a fixed-height box inside a tall empty pane.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* The probe result follows the operator into the catalog. It used to live
          only on the setup screen — the one place they leave the moment it turns
          green — so "which instance am I on, and does it have any tools?" had no
          answer from here. */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] text-green">
            Connected — {unifiedMcp.status?.toolCount ?? 0} tools
          </span>
          <span className="ml-2 truncate font-mono text-[10px] text-dim">
            {unifiedMcp.config?.endpoint ?? ""}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setManage(true)}
          className="flex-none text-[11px] text-blue hover:underline"
        >
          Manage connection
        </button>
      </div>
      {injection ? <InjectionTargets {...injection} /> : null}
      {connector ? <ConnectorCenter {...connector} /> : null}
    </div>
  )
}
