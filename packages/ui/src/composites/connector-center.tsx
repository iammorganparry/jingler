import type {
  ConnectorAuthField,
  ConnectorConnection,
  ConnectorProvider,
  OAuthClientInfo
} from "@starbase/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as React from "react"
import { cn } from "../lib/cn.js"
import { AsyncButton } from "../components/async-button.js"
import { Badge } from "../components/badge.js"
import { Callout } from "../components/callout.js"
import { Input } from "../components/input.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"

/**
 * The MCP Connector Center — browse the OpenConnector provider catalog and connect
 * providers (OAuth or API-key) in-app. PRESENTATIONAL: it renders from props and
 * calls back on actions, so it lives in `@starbase/ui` (storybookable, no rpc). The
 * desktop renderer wires `useConnectorCenter()` into `ConnectorCenterProps`.
 *
 * Secrets flow one way — form values go OUT through `onConnect` / `onSetOauthConfig`
 * and are never read back; the props carry no credential (see core `connector.ts`).
 */
export interface ConnectorCenterProps {
  readonly providers: ReadonlyArray<ConnectorProvider>
  readonly connections: ReadonlyArray<ConnectorConnection>
  readonly oauthConfigs: ReadonlyArray<OAuthClientInfo>
  readonly loading: boolean
  /** A read error (e.g. OpenConnector not configured / unreachable), or null. */
  readonly error: string | null
  readonly onConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>
  ) => Promise<void>
  readonly onDisconnect: (service: string) => Promise<void>
  readonly onSetOauthConfig: (
    provider: string,
    clientId: string,
    clientSecret: string
  ) => Promise<void>
  readonly onStartOauth: (service: string) => Promise<void>
  readonly onRefresh: () => void
}

const FALLBACK_FIELD: ConnectorAuthField = {
  name: "apiKey",
  label: "API key",
  kind: "password",
  required: true
}

export function ConnectorCenter({
  providers,
  connections,
  oauthConfigs,
  loading,
  error,
  onConnect,
  onDisconnect,
  onSetOauthConfig,
  onStartOauth,
  onRefresh
}: ConnectorCenterProps) {
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState<ConnectorProvider | null>(null)

  const connectedIds = React.useMemo(
    () => new Set(connections.map((c) => c.service)),
    [connections]
  )

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return providers
    return providers.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    )
  }, [providers, query])

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    getItemKey: (i) => filtered[i]?.id ?? i,
    overscan: 8
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-text-bright">Connector Center</h3>
          <p className="mt-0.5 text-[11px] text-dim">
            Connect providers once — every agent draws them from the shared OpenConnector.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-line bg-panel px-2.5 py-1 text-[11px] text-text hover:border-line-strong hover:bg-surface"
        >
          Refresh
        </button>
      </div>

      {error && providers.length === 0 ? (
        <Callout tone="blue">{error}</Callout>
      ) : null}

      {connections.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Connected</span>
          {connections.map((c) => (
            <ConnectionRow key={`${c.service}:${c.connectionName ?? ""}`} connection={c} onDisconnect={onDisconnect} />
          ))}
        </div>
      ) : null}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={loading ? "Loading providers…" : `Search ${providers.length} providers…`}
        aria-label="Search providers"
      />

      <div ref={scrollRef} className="max-h-[360px] overflow-y-auto rounded-lg border border-line">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const provider = filtered[item.index]
            if (!provider) return null
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`
                }}
              >
                <ProviderRow
                  provider={provider}
                  connected={connectedIds.has(provider.id)}
                  onOpen={() => setActive(provider)}
                />
              </div>
            )
          })}
          {filtered.length === 0 && !loading ? (
            <div className="px-3 py-6 text-center text-[12px] text-dim">No providers match “{query}”.</div>
          ) : null}
        </div>
      </div>

      <ConnectDialog
        provider={active}
        oauthInfo={active ? oauthConfigs.find((o) => o.provider === active.id) : undefined}
        onClose={() => setActive(null)}
        onConnect={onConnect}
        onSetOauthConfig={onSetOauthConfig}
        onStartOauth={onStartOauth}
      />
    </div>
  )
}

function ProviderRow({
  provider,
  connected,
  onOpen
}: {
  provider: ConnectorProvider
  connected: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 border-b border-line px-3 py-2 text-left hover:bg-hover"
    >
      <span className="flex size-[26px] flex-none items-center justify-center overflow-hidden rounded-md border border-line bg-sunken text-[12px] text-text-bright">
        {provider.icon ? (
          <img src={provider.icon} alt="" className="size-full object-contain" />
        ) : (
          provider.name.charAt(0).toUpperCase()
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-text-bright">{provider.name}</span>
          {connected ? (
            <Badge tone="green" size="xs">
              connected
            </Badge>
          ) : null}
        </div>
        <div className="font-mono text-[10px] text-dim">
          {provider.id}
          {provider.actionCount !== null ? ` · ${provider.actionCount} actions` : ""}
        </div>
      </div>
      <span className="text-[11px] text-blue">{connected ? "Manage" : "Connect"}</span>
    </button>
  )
}

function ConnectionRow({
  connection,
  onDisconnect
}: {
  connection: ConnectorConnection
  onDisconnect: (service: string) => Promise<void>
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-[11px] py-[9px]">
      <div className="min-w-0 flex-1">
        <span className="text-[12.5px] font-semibold text-text-bright">{connection.service}</span>
        <div className="font-mono text-[10px] text-dim">
          {connection.displayName ?? connection.accountId}
          {connection.grantedScopes.length > 0 ? ` · ${connection.grantedScopes.length} scopes` : ""}
        </div>
      </div>
      <AsyncButton
        variant="ghost"
        size="sm"
        pendingLabel="Removing…"
        onClick={() => onDisconnect(connection.service)}
      >
        Disconnect
      </AsyncButton>
    </div>
  )
}

function ConnectDialog({
  provider,
  oauthInfo,
  onClose,
  onConnect,
  onSetOauthConfig,
  onStartOauth
}: {
  provider: ConnectorProvider | null
  oauthInfo: OAuthClientInfo | undefined
  onClose: () => void
  onConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>
  ) => Promise<void>
  onSetOauthConfig: (provider: string, clientId: string, clientSecret: string) => Promise<void>
  onStartOauth: (service: string) => Promise<void>
}) {
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")

  // Reset the form whenever a different provider's dialog opens.
  React.useEffect(() => {
    setValues({})
    setClientId("")
    setClientSecret("")
  }, [provider?.id])

  if (!provider) return null

  const supportsOauth = provider.authTypes.includes("oauth2")
  const apiAuthType = provider.authTypes.includes("custom_credential") ? "custom_credential" : "api_key"
  const fields = provider.fields.length > 0 ? provider.fields : [FALLBACK_FIELD]
  const needsClient = supportsOauth && oauthInfo && !oauthInfo.hasClient

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>
            Credentials are stored by OpenConnector, never in Starbase.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {supportsOauth ? (
            <div className="flex flex-col gap-2">
              {needsClient ? (
                <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken p-2.5">
                  <span className="text-[11px] text-dim">
                    Register an OAuth app first. Redirect URI:{" "}
                    <span className="font-mono text-text">{oauthInfo?.expectedRedirectUri}</span>
                  </span>
                  <Input
                    placeholder="Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <Input
                    type="password"
                    placeholder="Client secret"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                  <AsyncButton
                    pendingLabel="Saving…"
                    disabled={clientId.length === 0 || clientSecret.length === 0}
                    onClick={() => onSetOauthConfig(provider.id, clientId, clientSecret)}
                  >
                    Save OAuth app
                  </AsyncButton>
                </div>
              ) : (
                <AsyncButton
                  pendingLabel="Opening browser…"
                  onClick={async () => {
                    await onStartOauth(provider.id)
                    onClose()
                  }}
                >
                  Connect with OAuth
                </AsyncButton>
              )}
            </div>
          ) : null}

          {supportsOauth && provider.authTypes.length > 1 ? (
            <div className="text-center text-[10px] uppercase tracking-wide text-dim">or use an API key</div>
          ) : null}

          {!supportsOauth || provider.authTypes.length > 1 ? (
            <div className="flex flex-col gap-2">
              {fields.map((f) => (
                <label key={f.name} className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{f.label}</span>
                  <Input
                    type={f.kind === "password" ? "password" : "text"}
                    placeholder={f.placeholder ?? f.label}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                </label>
              ))}
              <AsyncButton
                pendingLabel="Connecting…"
                disabled={fields.some((f) => f.required && (values[f.name] ?? "").length === 0)}
                onClick={async () => {
                  await onConnect(provider.id, apiAuthType, values)
                  onClose()
                }}
              >
                Connect
              </AsyncButton>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-panel px-3 py-1.5 text-[12px] text-text hover:bg-surface"
          >
            Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
