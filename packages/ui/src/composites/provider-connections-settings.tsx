import { NativeEndpointLogin, type NativeEndpointLoginActions } from "./native-endpoint-login.js"
import {
  type AgentEndpoint,
  type AgentEndpointCatalog,
  type AgentRuntimeId,
  type AuthKind,
  type AuthStatus,
  type CodexLoginMethod,
  ProviderConnectionId,
  type ProviderCatalog,
  type ProviderCatalogModel,
  ProviderId,
  type ProviderModelId
} from "@jingler/core"
import { useMachine } from "@xstate/react"
import { Check, LogOut, Plus, RefreshCw, Star } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Badge, type BadgeTone } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import { providerAuthRouteLabel } from "../lib/provider-connection-labels.js"
import { ProviderAuthForms } from "./provider-auth-forms.js"
import { ProviderConnectSheet } from "./provider-connect-sheet.js"
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
  <Button
    variant="outline"
    title={`${model.id} · ${model.verification}`}
    aria-pressed={isDefault}
    disabled={disabled || isDefault}
    onClick={onSelect}
    className={cn(
      "h-auto min-w-44 max-w-60 flex-col items-start justify-center gap-1 whitespace-normal px-3 py-2 text-left",
      isDefault && "border-blue/50 bg-blue/10 text-blue disabled:opacity-100"
    )}
  >
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
      {isDefault && <Check size={12} />}
      {model.label}
    </span>
    <span className={cn("text-[11px] font-normal text-dim", isDefault && "text-blue/80")}>
      {modelDescription(model)}
    </span>
    <span className="sr-only">
      {isDefault ? " default" : ` ${model.verification}`}
    </span>
  </Button>
)

const RUNTIMES: ReadonlyArray<{ id: AgentRuntimeId; label: string; description: string }> = [
  { id: "pi", label: "PI", description: "Run models through connected provider accounts." },
  { id: "claude", label: "Claude Code", description: "Use the Claude Code CLI installed on this target." },
  { id: "codex", label: "Codex CLI", description: "Use the Codex CLI and its target-local login." },
  { id: "opencode", label: "OpenCode CLI", description: "Use the OpenCode CLI installed on this target." }
]

const runtimeStatus = (
  runtimeId: AgentRuntimeId,
  endpoints: AgentEndpointCatalog["endpoints"]
): string => {
  if (runtimeId === "pi" && endpoints.length === 0) return "Needs provider"
  if (endpoints.length === 0) return "Not detected"
  const installed = endpoints.filter(({ endpoint }) => endpoint.status !== "missing")
  if (installed.length === 0) return "Not installed"
  const ready = endpoints.filter(({ endpoint }) => endpoint.status === "ready").length
  if (ready === endpoints.length) return "Ready"
  if (installed.every(({ endpoint }) => endpoint.status === "signed-out")) return "Sign in required"
  if (installed.every(({ endpoint }) => endpoint.status === "unsupported")) return "Unsupported"
  if (installed.every(({ endpoint }) => endpoint.status === "stale-agent")) return "Update required"
  if (installed.every(({ endpoint }) => endpoint.status === "error")) return "Unavailable"
  return `${ready}/${endpoints.length} ready`
}

const statusTone = (status: string): BadgeTone =>
  status === "Ready"
    ? "green"
    : status === "Unsupported" || status === "Unavailable"
      ? "red"
      : status === "Needs provider" || status === "Sign in required" || status === "Update required"
        ? "yellow"
        : "neutral"

const endpointDotTone = (status: string): string =>
  status === "ready"
    ? "bg-green"
    : status === "error" || status === "unsupported"
      ? "bg-red"
      : status === "missing"
        ? "bg-line-strong"
        : "bg-yellow"

function RuntimeCard({
  label,
  description,
  status,
  selected,
  onSelect
}: {
  readonly label: string
  readonly description: string
  readonly status: string
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <Button
      variant="outline"
      aria-label={`${label}: ${status}`}
      aria-pressed={selected}
      disabled={status === "Unsupported"}
      onClick={onSelect}
      className={cn(
        "h-auto flex-col items-start justify-start gap-1.5 whitespace-normal p-3 text-left disabled:opacity-40",
        selected && "border-blue/50 bg-blue/10"
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-text-bright">{label}</span>
        <Badge tone={statusTone(status)} size="xs">{status}</Badge>
      </span>
      <span className="text-[11.5px] font-normal leading-snug text-muted-foreground">{description}</span>
    </Button>
  )
}

function NativeEndpointRow({
  endpoint,
  nativeEndpointLogin
}: {
  readonly endpoint: AgentEndpoint
  readonly nativeEndpointLogin?: NativeEndpointLoginActions
}) {
  return (
    <div className="py-2.5 text-[12.5px] text-muted-foreground">
      {endpoint.runtimeId === "claude" ? (
        <span>
          {endpoint.label}, {endpoint.status}, {endpoint.targetId}
          {endpoint.status === "signed-out" && <span>. Run <code>claude auth login</code> on this target, then refresh runtimes.</span>}
          {endpoint.status === "unsupported" && <span> · Install the supported Claude Code version on this target.</span>}
        </span>
      ) : (
        <NativeEndpointLogin endpoint={endpoint} actions={nativeEndpointLogin} />
      )}
    </div>
  )
}

function SelectedRuntimePanel({
  runtimeId,
  endpoints,
  nativeEndpointLogin,
  piSetup
}: {
  readonly runtimeId: AgentRuntimeId
  readonly endpoints: AgentEndpointCatalog["endpoints"]
  readonly nativeEndpointLogin?: NativeEndpointLoginActions
  readonly piSetup: ReactNode
}) {
  if (runtimeId === "pi") {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[13px] font-semibold text-text-bright">Provider accounts for PI</div>
        <div className="text-[12px] text-muted-foreground">
          Each account keeps its own target and billing route.
        </div>
        {piSetup}
      </div>
    )
  }
  if (endpoints.length === 0) {
    return (
      <div className="text-[12.5px] text-muted-foreground">
        This CLI was not detected on the current target. Install or configure it there, then refresh runtimes.
      </div>
    )
  }
  return (
    <div className="flex flex-col divide-y divide-hairline">
      {endpoints.map(({ endpoint }) => (
        <NativeEndpointRow key={endpoint.id} endpoint={endpoint} nativeEndpointLogin={nativeEndpointLogin} />
      ))}
    </div>
  )
}

function AgentRuntimeSetup({
  endpointCatalog,
  nativeEndpointLogin,
  piSetup
}: {
  readonly endpointCatalog: AgentEndpointCatalog | null
  readonly nativeEndpointLogin?: NativeEndpointLoginActions
  readonly piSetup: ReactNode
}) {
  const [selectedRuntime, setSelectedRuntime] = useState<AgentRuntimeId>("pi")
  const endpointsFor = (runtimeId: AgentRuntimeId) =>
    endpointCatalog?.endpoints.filter(({ endpoint }) => endpoint.runtimeId === runtimeId) ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {RUNTIMES.map((runtime) => (
          <RuntimeCard
            key={runtime.id}
            label={runtime.label}
            description={runtime.description}
            status={runtimeStatus(runtime.id, endpointsFor(runtime.id))}
            selected={selectedRuntime === runtime.id}
            onSelect={() => setSelectedRuntime(runtime.id)}
          />
        ))}
      </div>
      <SelectedRuntimePanel
        runtimeId={selectedRuntime}
        endpoints={endpointsFor(selectedRuntime)}
        nativeEndpointLogin={nativeEndpointLogin}
        piSetup={piSetup}
      />
    </div>
  )
}

const connectionDotTone = (status: AuthStatus): string =>
  status === "authenticated" ? "bg-green" : status === "connecting" ? "bg-yellow" : "bg-red"

function ConnectionsList({
  connections,
  endpoints,
  selectedId,
  defaultConnectionId,
  busy,
  onSelect,
  onRemove
}: {
  readonly connections: ProviderCatalog["connections"]
  readonly endpoints: AgentEndpointCatalog["endpoints"]
  readonly selectedId: ProviderConnectionId | null
  readonly defaultConnectionId: ProviderConnectionId | null
  readonly busy: boolean
  readonly onSelect: (connectionId: ProviderConnectionId) => void
  readonly onRemove: (connectionId: ProviderConnectionId) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-text-bright">Connections</h3>
      {connections.length === 0 && endpoints.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          No provider connection is configured. Add one here when you are ready.
        </p>
      )}
      <div className="flex flex-col divide-y divide-hairline">
        {connections.map(({ connection, models }) => (
          <div
            key={connection.id}
            className={cn("flex items-center gap-2 rounded-md", selectedId === connection.id && "bg-hover")}
          >
            <Button
              variant="ghost"
              onClick={() => onSelect(connection.id)}
              className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-2 py-2.5 text-left"
            >
              <StatusDot tone={connectionDotTone(connection.status)} size={7} />
              <ProviderIcon providerId={connection.providerId} size={14} />
              <span className="text-[13px] font-medium text-text-bright">
                {providerAuthRouteLabel(connection.authKind)}
              </span>
              {connection.id === defaultConnectionId && (
                <Star size={11} className="shrink-0 fill-current text-dim" aria-label="Default connection" />
              )}
              <span className="ml-auto font-mono text-[11px] font-normal text-dim">
                {connection.targetId} · {models.filter(({ selectable }) => selectable).length} certified
              </span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Sign out ${providerAuthRouteLabel(connection.authKind)} connection`}
              disabled={busy}
              onClick={() => onRemove(connection.id)}
              className="mr-1 flex-none text-dim hover:text-red"
            >
              <LogOut size={12} /> Sign out
            </Button>
          </div>
        ))}
      </div>
      {endpoints.length > 0 && (
        <fieldset className="m-0 flex min-w-0 flex-col divide-y divide-hairline border-0 p-0">
          <legend className="sr-only">Agent runtime endpoints</legend>
          {endpoints.map(({ endpoint }) => (
            <div key={endpoint.id} className="flex items-center gap-2.5 px-2 py-2.5 text-[12.5px] text-muted-foreground">
              <StatusDot tone={endpointDotTone(endpoint.status)} size={7} />
              <span>{endpoint.label} · {endpoint.status} · {endpoint.targetId}</span>
            </div>
          ))}
        </fieldset>
      )}
    </section>
  )
}

export interface ProviderConnectionsSettingsProps {
  catalog: ProviderCatalog | null
  nativeEndpointLogin?: NativeEndpointLoginActions
  endpointCatalog?: AgentEndpointCatalog | null
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
  /** Irreversibly removes a connection row (credential + persisted record). */
  onRemove?: (connectionId: ProviderConnectionId) => void
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
  /** Provider.cancelLogin for the reconnect `ProviderConnectSheet`'s OAuth-waiting Cancel button. */
  onCancelLogin: (connectionId: ProviderConnectionId) => Promise<void>
  /** Sets and verifies an API key from the reconnect `ProviderConnectSheet`; resolves ok or an error message. */
  onSaveApiKey: (
    connectionId: ProviderConnectionId,
    providerId: ProviderId,
    apiKey: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}

type ConnectionEntry = ProviderCatalog["connections"][number]

function ReconnectPanel({
  entry,
  busy,
  pendingAuthKind,
  open,
  onOpenChange,
  onConnectClaude,
  onStartCodex,
  onSetApiKey,
  onCancelLogin,
  onSaveApiKey
}: {
  readonly entry: ConnectionEntry
  readonly busy: boolean
  readonly pendingAuthKind: AuthKind | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
} & Pick<
  ProviderConnectionsSettingsProps,
  "onConnectClaude" | "onStartCodex" | "onSetApiKey" | "onCancelLogin" | "onSaveApiKey"
>) {
  const { connection } = entry
  const sheetAuth = connection.authKind === "openai-codex-oauth" || connection.authKind === "api-key"
  return (
    <div className="flex flex-col gap-3 border-t border-hairline pt-4">
      <Callout tone="blue">
        Reauthentication required. Jingler has not retained usable credentials for this connection.
      </Callout>
      {sheetAuth ? (
        <>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => onOpenChange(true)}>
              Reconnect
            </Button>
          </div>
          <ProviderConnectSheet
            open={open}
            onOpenChange={onOpenChange}
            providerId={connection.providerId}
            providerLabel={providerAuthRouteLabel(connection.authKind)}
            busy={busy}
            onStartOauth={async () => {
              onStartCodex(connection.id, "browser")
              return connection.id
            }}
            onStartDeviceCode={
              connection.authKind === "openai-codex-oauth"
                ? async () => {
                    onStartCodex(connection.id, "device-code")
                    return connection.id
                  }
                : undefined
            }
            onCancelLogin={() => onCancelLogin(connection.id)}
            onReopenBrowser={() => {}}
            onSaveApiKey={(apiKey) => onSaveApiKey(connection.id, connection.providerId, apiKey)}
          />
        </>
      ) : (
        <ProviderAuthForms
          busy={busy}
          mode="reconnect"
          pendingAuthKind={pendingAuthKind}
          authKinds={[connection.authKind]}
          apiProviderId={connection.providerId}
          onConnectClaude={(token) => onConnectClaude(connection.id, token)}
          onStartCodex={(method) => onStartCodex(connection.id, method)}
          onConnectApi={(_providerId, apiKey) => onSetApiKey(connection.id, connection.providerId, apiKey)}
        />
      )}
    </div>
  )
}

function ConnectionHeading({
  entry,
  busy,
  onRefresh,
  onLogout
}: {
  readonly entry: ConnectionEntry
  readonly busy: boolean
  readonly onRefresh: (connectionId: ProviderConnectionId) => void
  readonly onLogout: (connectionId: ProviderConnectionId) => void
}) {
  const { connection } = entry
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-text-bright">{providerAuthRouteLabel(connection.authKind)}</div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          {connection.account?.displayLabel ?? connection.account?.fingerprint ?? "Account identity unavailable"}
        </div>
        <div className="mt-1 text-[12px] text-dim">
          {connection.subscription.planLabel ?? "Plan not reported"} · {connection.targetId} · billing: {connection.subscription.confirmedBillingRoute ?? "unconfirmed"}
        </div>
      </div>
      <Button variant="ghost" size="sm" disabled={busy || connection.status !== "authenticated"} onClick={() => onRefresh(connection.id)}>
        {busy ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onLogout(connection.id)}>
        <LogOut size={12} /> Log out
      </Button>
    </div>
  )
}

function ModelList({
  entry,
  busy,
  defaultConnectionId,
  defaultModelId,
  onMakeDefault
}: {
  readonly entry: ConnectionEntry
  readonly busy: boolean
  readonly defaultConnectionId: ProviderConnectionId | null
  readonly defaultModelId: ProviderModelId | null
  readonly onMakeDefault: ProviderConnectionsSettingsProps["onMakeDefault"]
}) {
  const { connection, models } = entry
  return (
    <section className="flex flex-col gap-2 border-t border-hairline pt-4">
      <h3 className="text-[13px] font-semibold text-text-bright">Models</h3>
      <div className="flex flex-wrap gap-2">
        {models.map((model) => (
          <ModelChip
            key={model.id}
            model={model}
            isDefault={connection.id === defaultConnectionId && model.id === defaultModelId}
            disabled={busy || connection.status !== "authenticated"}
            onSelect={() =>
              onMakeDefault({ connectionId: connection.id, providerId: model.providerId, modelId: model.id })
            }
          />
        ))}
      </div>
    </section>
  )
}

export function ProviderConnectionsSettings({
  catalog,
  endpointCatalog = null,
  nativeEndpointLogin,
  defaultConnectionId = null,
  defaultModelId = null,
  busy = false,
  pendingAuthKind = null,
  error = null,
  onRefresh,
  onMakeDefault,
  onLogout,
  onRemove,
  onConnectClaude,
  onStartCodex,
  onSetApiKey,
  onCancelLogin,
  onSaveApiKey
}: ProviderConnectionsSettingsProps) {
  const [reconnectOpen, setReconnectOpen] = useState(false)
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
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="flex w-full max-w-[760px] flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold text-text-bright">Providers</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Each connection pins an account, target, and billing route. Jingler never falls through to another credential.
            </p>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => sendSelection({ type: "ADD" })}>
            <Plus size={12} /> Add runtime
          </Button>
        </div>
        {error && <Callout tone="red">{error}</Callout>}
        <ConnectionsList
          connections={connections}
          endpoints={endpointCatalog?.endpoints ?? []}
          selectedId={selected?.connection.id ?? null}
          defaultConnectionId={defaultConnectionId}
          busy={busy}
          onSelect={(connectionId) => sendSelection({ type: "SELECT", connectionId })}
          onRemove={onRemove ?? onLogout}
        />
        {selected ? (
          <section className="flex flex-col gap-4 border-t border-hairline pt-4">
            <ConnectionHeading entry={selected} busy={busy} onRefresh={onRefresh} onLogout={onLogout} />
            {selected.connection.status !== "authenticated" && (
              <ReconnectPanel
                entry={selected}
                busy={busy}
                pendingAuthKind={pendingAuthKind}
                open={reconnectOpen}
                onOpenChange={setReconnectOpen}
                onConnectClaude={onConnectClaude}
                onStartCodex={onStartCodex}
                onSetApiKey={onSetApiKey}
                onCancelLogin={onCancelLogin}
                onSaveApiKey={onSaveApiKey}
              />
            )}
            <ModelList
              entry={selected}
              busy={busy}
              defaultConnectionId={defaultConnectionId}
              defaultModelId={defaultModelId}
              onMakeDefault={onMakeDefault}
            />
          </section>
        ) : (
          <section className="flex flex-col gap-4 border-t border-hairline pt-4">
            <div>
              <h3 className="text-[14px] font-semibold text-text-bright">Add an agent runtime</h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Choose PI or a target-local CLI. Authentication stays owned by the selected runtime.
              </p>
            </div>
            <AgentRuntimeSetup
              endpointCatalog={endpointCatalog}
              nativeEndpointLogin={nativeEndpointLogin}
              piSetup={(
                <ProviderAuthForms
                  busy={busy}
                  pendingAuthKind={pendingAuthKind}
                  onConnectClaude={(token) => onConnectClaude(newConnectionId(), token)}
                  onStartCodex={(method) => onStartCodex(newConnectionId(), method)}
                  onConnectApi={(providerId, apiKey) =>
                    onSetApiKey(newConnectionId(), ProviderId.make(providerId), apiKey)
                  }
                />
              )}
            />
          </section>
        )}
      </div>
    </div>
  )
}
