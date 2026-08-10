import type {
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { Check, LogOut, RefreshCw, ShieldCheck } from "lucide-react"
import * as React from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import { providerAuthRouteLabel, providerStatusTone } from "../lib/provider-connection-labels.js"

export interface ProviderConnectionsSettingsProps {
  catalog: ProviderCatalog | null
  defaultConnectionId?: ProviderConnectionId | null
  defaultModelId?: ProviderModelId | null
  busy?: boolean
  error?: string | null
  onRefresh: (connectionId: ProviderConnectionId) => void
  onVerify: (connectionId: ProviderConnectionId, modelId: ProviderModelId) => void
  onMakeDefault: (selection: {
    connectionId: ProviderConnectionId
    providerId: ProviderId
    modelId: ProviderModelId
  }) => void
  onLogout: (connectionId: ProviderConnectionId) => void
}

export function ProviderConnectionsSettings({
  catalog,
  defaultConnectionId = null,
  defaultModelId = null,
  busy = false,
  error = null,
  onRefresh,
  onVerify,
  onMakeDefault,
  onLogout
}: ProviderConnectionsSettingsProps) {
  const connections = catalog?.connections ?? []
  const [selectedId, setSelectedId] = React.useState<ProviderConnectionId | null>(
    defaultConnectionId ?? connections[0]?.connection.id ?? null
  )
  const selected =
    connections.find(({ connection }) => connection.id === selectedId) ?? connections[0] ?? null

  return (
    <>
      <div className="flex w-[328px] max-w-[45%] flex-none flex-col border-r border-hairline">
        <div className="flex flex-none flex-col gap-1 p-4 pb-3">
          <span className="text-[15px] font-bold text-text-bright">Provider connections</span>
          <span className="text-[11.5px] leading-relaxed text-muted-foreground">
            Each connection pins an account, target, and billing route. Jingler never falls through to another credential.
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 overflow-auto p-3 pt-1">
          {connections.map(({ connection, models }) => (
            <button
              key={connection.id}
              type="button"
              onClick={() => setSelectedId(connection.id)}
              className={cn(
                "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left",
                selected?.connection.id === connection.id
                  ? "border-blue/50 bg-blue/10"
                  : "border-line bg-sunken hover:bg-hover"
              )}
            >
              <span className="flex items-center gap-2 text-[12px] font-medium text-text-bright">
                <StatusDot tone={providerStatusTone(connection.status)} size={7} glow={connection.status === "authenticated"} />
                {providerAuthRouteLabel(connection.authKind)}
              </span>
              <span className="font-mono text-[10px] text-dim">
                {connection.targetId} · {models.filter(({ selectable }) => selectable).length} certified
              </span>
            </button>
          ))}
          {connections.length === 0 && (
            <div className="rounded-lg border border-line bg-sunken p-3 text-[11.5px] text-muted-foreground">
              No provider connection is configured. Complete provider setup to add one.
            </div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-editor">
        <div className="flex flex-1 flex-col gap-5 overflow-auto p-6">
          {error && <Callout tone="red">{error}</Callout>}
          {selected ? (
            <>
              <div className="flex items-start gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-canvas">
                  <ShieldCheck size={18} className={selected.connection.status === "authenticated" ? "text-green" : "text-dim"} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold text-text-bright">{providerAuthRouteLabel(selected.connection.authKind)}</div>
                  <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">
                    {selected.connection.account?.displayLabel ?? selected.connection.account?.fingerprint ?? "Account identity unavailable"}
                  </div>
                  <div className="mt-1 text-[11px] text-dim">
                    {selected.connection.subscription.planLabel ?? "Plan not reported"} · {selected.connection.targetId} · billing: {selected.connection.subscription.confirmedBillingRoute ?? "unconfirmed"}
                  </div>
                </div>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRefresh(selected.connection.id)}>
                  {busy ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onLogout(selected.connection.id)}>
                  <LogOut size={12} /> Log out
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                <div className="text-[12px] font-semibold text-text-bright">Models</div>
                {selected.models.map((model) => {
                  const isDefault =
                    selected.connection.id === defaultConnectionId && model.id === defaultModelId
                  return (
                    <div key={model.id} className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium text-text-body">{model.label}</div>
                        <div className="font-mono text-[10px] text-dim">{model.id} · {model.verification}</div>
                      </div>
                      {isDefault ? (
                        <span className="flex items-center gap-1 rounded-md bg-blue/10 px-2 py-1 text-[10.5px] font-medium text-blue"><Check size={11} /> Default</span>
                      ) : model.selectable ? (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMakeDefault({ connectionId: selected.connection.id, providerId: model.providerId, modelId: model.id })}>Make default</Button>
                      ) : (
                        <Button variant="secondary" size="sm" disabled={busy || selected.connection.status !== "authenticated"} onClick={() => onVerify(selected.connection.id, model.id)}>Verify</Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="text-[12px] text-muted-foreground">Connect a provider to browse certified models.</div>
          )}
        </div>
      </div>
    </>
  )
}
