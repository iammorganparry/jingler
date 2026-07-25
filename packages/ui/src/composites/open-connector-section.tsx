import type { McpServerStatus, OpenConnectorConfig } from "@starbase/core"
import * as React from "react"
import { AsyncButton } from "../components/async-button.js"
import { Callout } from "../components/callout.js"
import { Input } from "../components/input.js"
import { Toggle } from "../components/toggle.js"

/**
 * Settings → Unified MCP. Configures the ONE self-hosted OpenConnector instance
 * every agent (and the Connector Center) draws from: its `/mcp` endpoint, the
 * bearer token, and the master enable switch, with a live "Test" probe.
 *
 * PRESENTATIONAL: it renders from props and calls back — the desktop renderer
 * wires `useOpenConnector()` in. The token is write-only: `hasToken` says whether
 * one is stored, but the value never comes back, so an empty field means "keep the
 * stored token" and only a typed value replaces it.
 */
export interface OpenConnectorSectionProps {
  readonly config: OpenConnectorConfig | undefined
  readonly hasToken: boolean
  readonly loading: boolean
  readonly save: (config: OpenConnectorConfig, token?: string | null) => Promise<void>
  readonly status: McpServerStatus | null
  readonly testing: boolean
  readonly test: () => void
}

export function OpenConnectorSection({
  config,
  hasToken,
  loading,
  save,
  status,
  testing,
  test
}: OpenConnectorSectionProps) {
  const [endpoint, setEndpoint] = React.useState("")
  const [token, setToken] = React.useState("")
  const [enabled, setEnabled] = React.useState(false)

  // Seed the local fields once the persisted config arrives.
  React.useEffect(() => {
    if (config) {
      setEndpoint(config.endpoint)
      setEnabled(config.enabled)
    }
  }, [config])

  const onSave = () =>
    save(
      { endpoint: endpoint.trim(), enabled, serverName: config?.serverName ?? "open-connector" },
      token.length > 0 ? token : undefined
    )

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-text-bright">Unified MCP (OpenConnector)</h3>
        <p className="mt-0.5 text-[11px] text-dim">
          Point every agent at one self-hosted OpenConnector <code className="font-mono">/mcp</code>{" "}
          endpoint. Providers you connect in the Connector Center then reach all agents.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Endpoint</span>
        <Input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={loading ? "Loading…" : "https://mcp.internal"}
        />
        <span className="text-[10px] text-dim">Base URL, without the /mcp suffix.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">API token</span>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? "•••••••• stored — leave blank to keep" : "Paste the instance token"}
        />
      </label>

      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-[12.5px] font-medium text-text-body">Enable</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Inject the shared server into every agent and unlock the Connector Center.
          </div>
        </div>
        <Toggle checked={enabled} onCheckedChange={setEnabled} className="mt-0.5" />
      </div>

      <div className="flex items-center gap-2">
        <AsyncButton pendingLabel="Saving…" onClick={onSave}>
          Save
        </AsyncButton>
        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="rounded-md border border-line bg-panel px-3 py-1.5 text-[12px] text-text hover:bg-surface disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      {status ? (
        <Callout tone={status.state === "connected" ? "green" : "red"}>
          {status.state === "connected"
            ? `Connected — ${status.toolCount ?? 0} tools`
            : status.error ?? "Could not reach the endpoint."}
        </Callout>
      ) : null}
    </div>
  )
}
