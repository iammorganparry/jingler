import * as React from "react"
import { ConnectorCenter, type ConnectorCenterProps } from "./connector-center.js"
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
}

export function ConnectorsSettings({ unifiedMcp, connector }: ConnectorsSettingsProps) {
  const [manage, setManage] = React.useState(false)

  // Probe once when the section opens (identity of `test` is stable — a useCallback
  // from the hook), so a LIVE connection, not just saved config, gates the catalog.
  const test = unifiedMcp?.test
  React.useEffect(() => {
    test?.()
  }, [test])

  if (!unifiedMcp) return null

  const connected = unifiedMcp.status?.state === "connected"

  // Not connected (or the operator chose to edit the connection) → setup view. The
  // section surfaces the onboarding banner / endpoint+token fields / Test + the
  // failure reason itself, so this is both the gate and the fix-it screen.
  if (!connected || manage) {
    return (
      <div className="flex flex-col gap-3">
        <OpenConnectorSection {...unifiedMcp} />
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
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setManage(true)}
        className="self-end text-[11px] text-blue hover:underline"
      >
        Manage connection
      </button>
      {connector ? <ConnectorCenter {...connector} /> : null}
    </div>
  )
}
