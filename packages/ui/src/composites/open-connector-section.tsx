import type { McpServerStatus, OpenConnectorConfig, OpenConnectorDefaults } from "@starbase/core"
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
  /** Env-aware onboarding defaults (dev = local, prod = hosted). */
  readonly defaults: OpenConnectorDefaults | undefined
  readonly loading: boolean
  readonly save: (config: OpenConnectorConfig, token?: string | null) => Promise<void>
  /** One-click onboarding: apply the environment default. */
  readonly autoSetup: () => Promise<void>
  readonly settingUp: boolean
  readonly status: McpServerStatus | null
  readonly testing: boolean
  readonly test: () => void
}

/** Whether the operator has configured anything yet (drives the onboarding banner). */
const isUnconfigured = (config: OpenConnectorConfig | undefined, hasToken: boolean): boolean =>
  (config === undefined || config.endpoint.length === 0) && !hasToken

export function OpenConnectorSection({
  config,
  hasToken,
  defaults,
  loading,
  save,
  autoSetup,
  settingUp,
  status,
  testing,
  test
}: OpenConnectorSectionProps) {
  const [endpoint, setEndpoint] = React.useState("")
  const [token, setToken] = React.useState("")
  const [enabled, setEnabled] = React.useState(false)

  // Seed the local fields once the persisted config arrives. When nothing is saved
  // yet, prefill the endpoint from the environment default so onboarding is one edit.
  React.useEffect(() => {
    if (config && config.endpoint.length > 0) {
      setEndpoint(config.endpoint)
      setEnabled(config.enabled)
    } else if (defaults) {
      setEndpoint(defaults.endpoint)
    }
  }, [config, defaults])

  const onboarding = isUnconfigured(config, hasToken)

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
          Point every agent at one OpenConnector <code className="font-mono">/mcp</code> endpoint.
          Providers you connect in the Connector Center then reach all agents.
        </p>
      </div>

      {onboarding && defaults ? (
        <Callout tone="blue">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-body">
              {defaults.kind === "local"
                ? `Detected a local OpenConnector at ${defaults.endpoint} — set it up in one click.`
                : `Use the Starbase-hosted OpenConnector (${defaults.endpoint}).`}
            </span>
            <AsyncButton
              pendingLabel="Setting up…"
              onClick={autoSetup}
              disabled={settingUp}
            >
              Set up automatically
            </AsyncButton>
          </div>
        </Callout>
      ) : null}

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
