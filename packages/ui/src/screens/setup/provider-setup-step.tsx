import type {
  CodexLoginMethod,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderLoginEvent,
  ProviderModelId
} from "@jingler/core"
import { ExternalLink, KeyRound, ShieldCheck, X } from "lucide-react"
import { useRef } from "react"
import { Button } from "../../components/button.js"
import { Callout } from "../../components/callout.js"
import { Eyebrow } from "../../components/eyebrow.js"
import { Input } from "../../components/input.js"
import { Spinner } from "../../components/loading.js"
import { StatusDot } from "../../components/status-dot.js"
import { providerAuthRouteLabel, providerStatusTone } from "../../lib/provider-connection-labels.js"

export interface ProviderSetupStepProps {
  catalog: ProviderCatalog | null
  loginEvent: ProviderLoginEvent | null
  busy: boolean
  error: string | null
  onConnectClaude: (token: string) => void
  onStartCodex: (method: CodexLoginMethod) => void
  onConnectApi: (providerId: string, apiKey: string) => void
  onSelectModel: (selection: {
    connectionId: ProviderConnectionId
    providerId: ProviderId
    modelId: ProviderModelId
  }) => void
  onCancel: () => void
  onRetry: () => void
}

export function ProviderSetupStep({
  catalog,
  loginEvent,
  busy,
  error,
  onConnectClaude,
  onStartCodex,
  onConnectApi,
  onSelectModel,
  onCancel,
  onRetry
}: ProviderSetupStepProps) {
  const claudeToken = useRef<HTMLInputElement>(null)
  const apiKey = useRef<HTMLInputElement>(null)
  const apiProvider = useRef<HTMLSelectElement>(null)

  const submitClaude = () => {
    const token = claudeToken.current?.value.trim() ?? ""
    if (!token) return
    if (claudeToken.current) claudeToken.current.value = ""
    onConnectClaude(token)
  }

  const submitApiKey = () => {
    const key = apiKey.current?.value.trim() ?? ""
    const providerId = apiProvider.current?.value ?? "anthropic"
    if (!key) return
    if (apiKey.current) apiKey.current.value = ""
    onConnectApi(providerId, key)
  }

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <Eyebrow>Welcome · 3 of 4</Eyebrow>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
          Connect a model provider
        </h1>
        <p className="text-[13px] leading-[1.6] text-muted-foreground">
          Choose the exact account and billing route Jingler should use. A subscription connection
          never falls back to an API key.
        </p>
      </div>

      {error && (
        <Callout tone="red">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        </Callout>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-line bg-sunken p-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-text-bright">
          <KeyRound size={14} className="text-blue" /> Claude Pro / Max
        </div>
        <p className="text-[11px] leading-[1.55] text-muted-foreground">
          Run <code className="font-mono text-text">claude setup-token</code>, then paste the token
          once. Jingler sends it directly to encrypted main-process storage and clears this field.
        </p>
        <div className="flex gap-2">
          <Input ref={claudeToken} type="password" autoComplete="off" placeholder="Claude setup-token" disabled={busy} />
          <Button variant="primary" onClick={submitClaude} disabled={busy}>Connect Claude</Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-line bg-sunken p-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-text-bright">
          <ExternalLink size={14} className="text-cyan" /> ChatGPT Codex subscription
        </div>
        <p className="text-[11px] leading-[1.55] text-muted-foreground">
          Sign in through the browser or use a device code. The main process owns polling and token storage.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onStartCodex("browser")} disabled={busy}>Open browser</Button>
          <Button variant="secondary" onClick={() => onStartCodex("device-code")} disabled={busy}>Use device code</Button>
        </div>
      </div>

      <details className="rounded-lg border border-line bg-sunken p-3">
        <summary className="cursor-pointer text-[12px] font-medium text-text-body">Use an API key instead</summary>
        <div className="mt-3 flex gap-2">
          <select ref={apiProvider} className="rounded-md border border-line bg-canvas px-2 text-[12px] text-text" disabled={busy}>
            <option value="anthropic">Anthropic API</option>
            <option value="openai">OpenAI API</option>
            <option value="google">Google API</option>
            <option value="openrouter">OpenRouter API</option>
          </select>
          <Input ref={apiKey} type="password" autoComplete="off" placeholder="API key" disabled={busy} />
          <Button variant="secondary" onClick={submitApiKey} disabled={busy}>Save API key</Button>
        </div>
      </details>

      {busy && (
        <div className="flex items-center justify-between rounded-lg border border-line bg-hover px-3 py-2 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-2"><Spinner size={13} /> Authenticating or verifying…</span>
          <Button variant="ghost" size="sm" onClick={onCancel}><X size={13} /> Cancel</Button>
        </div>
      )}

      {loginEvent?.type === "device-code" && (
        <div className="rounded-lg border border-blue/40 bg-hover px-3 py-3">
          <div className="text-[11px] text-muted-foreground">Enter this device code in the opened browser</div>
          <div className="mt-1 font-mono text-[20px] font-semibold tracking-[0.18em] text-text-bright">{loginEvent.userCode}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-dim">{loginEvent.verificationUri}</div>
        </div>
      )}
      {(loginEvent?.type === "info" || loginEvent?.type === "progress") && (
        <div className="text-[11px] text-muted-foreground">{loginEvent.message}</div>
      )}

      {catalog?.connections.map(({ connection, models }) => (
        <div key={connection.id} className="flex flex-col gap-3 rounded-lg border border-line bg-hover p-3">
          <div className="flex items-start gap-2">
            <StatusDot tone={providerStatusTone(connection.status)} size={8} glow={connection.status === "authenticated"} />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-text-bright">{providerAuthRouteLabel(connection.authKind)}</div>
              <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                {connection.account?.displayLabel ?? connection.account?.fingerprint ?? connection.id}
                {connection.subscription.planLabel ? ` · ${connection.subscription.planLabel}` : ""}
                {connection.subscription.confirmedBillingRoute ? ` · ${connection.subscription.confirmedBillingRoute}` : ""}
              </div>
            </div>
            {connection.status === "authenticated" && <ShieldCheck size={15} className="text-green" />}
          </div>
          {models.map((model) => (
            <div key={model.id} className="flex items-center justify-between gap-3 border-t border-line pt-2">
              <div>
                <div className="text-[12px] text-text-body">{model.label}</div>
                <div className="font-mono text-[10px] text-dim">{model.verification}</div>
              </div>
              <Button
                variant={model.selectable ? "primary" : "secondary"}
                size="sm"
                disabled={busy || connection.status !== "authenticated"}
                onClick={() => onSelectModel({
                  connectionId: connection.id,
                  providerId: model.providerId,
                  modelId: model.id
                })}
              >
                {model.selectable ? "Use model" : "Verify model"}
              </Button>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
