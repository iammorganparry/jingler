import {
  type AuthKind,
  type CodexLoginMethod,
  ProviderConnectionId,
  type ProviderCatalog,
  type ProviderCatalogModel,
  ProviderId,
  type ProviderModelId
} from "@jingler/core"
import { useMachine } from "@xstate/react"
import { Check, LogOut, Plus, RefreshCw, ShieldCheck } from "lucide-react"
import { useEffect, useMemo } from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"
import { providerAuthRouteLabel } from "../lib/provider-connection-labels.js"
import { ProviderAuthForms } from "./provider-auth-forms.js"
import { providerConnectionsSettingsMachine } from "./provider-connections-settings-machine.js"

const EMPTY_CONNECTIONS: ProviderCatalog["connections"] = []

const compactNumber = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  notation: "compact"
})

const modelDescription = (model: ProviderCatalogModel): string => {
  const details: string[] = []
  if (model.capabilities.contextWindow !== null) {
    details.push(`${compactNumber.format(model.capabilities.contextWindow)} context`)
  }
  if (model.capabilities.vision) details.push("Vision")
  const highestReasoning = model.capabilities.reasoning.at(-1)
  if (highestReasoning) {
    details.push(
      `Reasoning up to ${highestReasoning[0]?.toUpperCase()}${highestReasoning.slice(1)}`
    )
  }
  return details.join(" · ") || "Text generation"
}

const ModelChip = ({
  model,
  isDefault,
  disabled,
  onSelect
}: {
  readonly model: ProviderCatalogModel
  readonly isDefault: boolean
  readonly disabled: boolean
  readonly onSelect: () => void
}) => (
  <button
    type="button"
    title={`${model.id} · ${model.verification}`}
    aria-pressed={isDefault}
    disabled={disabled || isDefault}
    onClick={onSelect}
    className={cn(
      "inline-flex min-h-14 min-w-44 max-w-60 flex-col items-start justify-center gap-1 rounded-xl border px-3 py-2 text-left transition-colors",
      isDefault
        ? "border-blue/50 bg-blue/10 text-blue"
        : "border-line bg-sunken text-text-body hover:border-line-strong hover:bg-hover",
      disabled && "cursor-not-allowed opacity-50"
    )}
  >
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium">
      {isDefault && <Check size={11} />}
      {model.label}
    </span>
    <span className={cn("text-[9.5px] text-dim", isDefault && "text-blue/80")}>
      {modelDescription(model)}
    </span>
    <span className="sr-only">
      {isDefault ? " default" : ` ${model.verification}`}
    </span>
  </button>
)

export interface ProviderConnectionsSettingsProps {
  catalog: ProviderCatalog | null
  defaultConnectionId?: ProviderConnectionId | null
  defaultModelId?: ProviderModelId | null
  busy?: boolean
  pendingAuthKind?: AuthKind | null
  error?: string | null
  onReload?: () => void
  onRefresh: (connectionId: ProviderConnectionId) => void
  onVerify: (connectionId: ProviderConnectionId, modelId: ProviderModelId) => void
  onMakeDefault: (selection: {
    connectionId: ProviderConnectionId
    providerId: ProviderId
    modelId: ProviderModelId
  }) => void
  onLogout: (connectionId: ProviderConnectionId) => void
  onConnectClaude: (connectionId: ProviderConnectionId, token: string) => void
  onStartCodex: (
    connectionId: ProviderConnectionId,
    method: CodexLoginMethod
  ) => void
  onSetApiKey: (
    connectionId: ProviderConnectionId,
    providerId: ProviderId,
    apiKey: string
  ) => void
}

export function ProviderConnectionsSettings({
  catalog,
  defaultConnectionId = null,
  defaultModelId = null,
  busy = false,
  pendingAuthKind = null,
  error = null,
  onRefresh,
  onVerify,
  onMakeDefault,
  onLogout,
  onConnectClaude,
  onStartCodex,
  onSetApiKey
}: ProviderConnectionsSettingsProps) {
  const connections = catalog?.connections ?? EMPTY_CONNECTIONS
  const connectionIds = useMemo(
    () => connections.map(({ connection }) => connection.id),
    [connections]
  )
  const [selection, sendSelection] = useMachine(providerConnectionsSettingsMachine, {
    input: { connectionIds, defaultConnectionId }
  })
  useEffect(() => {
    sendSelection({ type: "CATALOG_UPDATED", connectionIds })
  }, [connectionIds, sendSelection])
  const adding = selection.matches("adding")
  const selected =
    adding
      ? null
      : connections.find(
          ({ connection }) => connection.id === selection.context.selectedId
        ) ?? connections[0] ?? null
  const newConnectionId = () => ProviderConnectionId.make(crypto.randomUUID())

  return (
    <>
      <div className="flex w-[328px] max-w-[45%] flex-none flex-col border-r border-hairline">
        <div className="flex flex-none flex-col gap-3 p-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[15px] font-bold text-text-bright">Provider connections</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => sendSelection({ type: "ADD" })}
            >
              <Plus size={12} /> Add account
            </Button>
          </div>
          <span className="text-[11.5px] leading-relaxed text-muted-foreground">
            Each connection pins an account, target, and billing route. Jingler never falls through to another credential.
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 overflow-auto p-3 pt-1">
          {connections.map(({ connection, models }) => (
            <button
              key={connection.id}
              type="button"
              onClick={() =>
                sendSelection({ type: "SELECT", connectionId: connection.id })
              }
              className={cn(
                "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left",
                selected?.connection.id === connection.id
                  ? "border-blue/50 bg-blue/10"
                  : "border-line bg-sunken hover:bg-hover"
              )}
            >
              <span className="flex items-center gap-2 text-[12px] font-medium text-text-bright">
                <ProviderIcon providerId={connection.providerId} size={13} />
                {providerAuthRouteLabel(connection.authKind)}
              </span>
              <span className="font-mono text-[10px] text-dim">
                {connection.targetId} · {models.filter(({ selectable }) => selectable).length} certified
              </span>
            </button>
          ))}
          {connections.length === 0 && (
            <div className="rounded-lg border border-line bg-sunken p-3 text-[11.5px] text-muted-foreground">
              No provider connection is configured. Add one here when you are ready.
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
                <Button variant="ghost" size="sm" disabled={busy || selected.connection.status !== "authenticated"} onClick={() => onRefresh(selected.connection.id)}>
                  {busy ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onLogout(selected.connection.id)}>
                  <LogOut size={12} /> Log out
                </Button>
              </div>

              {selected.connection.status !== "authenticated" && (
                <div className="flex flex-col gap-3 rounded-lg border border-yellow/30 bg-yellow/[0.04] p-3">
                  <Callout tone="yellow">
                    Reauthentication required. Jingler has not retained usable credentials for this connection.
                  </Callout>
                  <ProviderAuthForms
                    busy={busy}
                    mode="reconnect"
                    pendingAuthKind={pendingAuthKind}
                    authKinds={[selected.connection.authKind]}
                    apiProviderId={selected.connection.providerId}
                    onConnectClaude={(token) =>
                      onConnectClaude(selected.connection.id, token)
                    }
                    onStartCodex={(method) =>
                      onStartCodex(selected.connection.id, method)
                    }
                    onConnectApi={(_providerId, apiKey) =>
                      onSetApiKey(
                        selected.connection.id,
                        selected.connection.providerId,
                        apiKey
                      )
                    }
                  />
                </div>
              )}

              <div className="flex flex-col gap-2">
                <div className="text-[12px] font-semibold text-text-bright">Models</div>
                <div className="flex flex-wrap gap-2">
                  {selected.models.map((model) => {
                    const isDefault =
                      selected.connection.id === defaultConnectionId && model.id === defaultModelId
                      && model.verification === "certified"
                    return (
                      <ModelChip
                        key={model.id}
                        model={model}
                        isDefault={isDefault}
                        disabled={busy || selected.connection.status !== "authenticated"}
                        onSelect={() => {
                          if (model.verification !== "certified") {
                            onVerify(selected.connection.id, model.id)
                            return
                          }
                          onMakeDefault({
                            connectionId: selected.connection.id,
                            providerId: model.providerId,
                            modelId: model.id
                          })
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="flex max-w-2xl flex-col gap-4">
              <div>
                <div className="text-[15px] font-semibold text-text-bright">Add a provider connection</div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  Authenticate an account now; model availability is checked automatically when selected.
                </div>
              </div>
              <ProviderAuthForms
                busy={busy}
                pendingAuthKind={pendingAuthKind}
                onConnectClaude={(token) =>
                  onConnectClaude(newConnectionId(), token)
                }
                onStartCodex={(method) =>
                  onStartCodex(newConnectionId(), method)
                }
                onConnectApi={(providerId, apiKey) =>
                  onSetApiKey(
                    newConnectionId(),
                    ProviderId.make(providerId),
                    apiKey
                  )
                }
              />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
