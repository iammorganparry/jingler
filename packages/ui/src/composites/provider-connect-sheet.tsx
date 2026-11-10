import type { ProviderConnectionId, ProviderId } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { AlertCircle, Check, ExternalLink, Eye, EyeOff, Lock } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { fromPromise } from "xstate"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { DeviceCodeBlock } from "../components/device-code-block.js"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "../components/drawer.js"
import { Field } from "../components/field.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"
import { ProviderIcon, providerLabel } from "../components/provider-icon.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/select.js"
import { StatusRow } from "../components/status-row.js"
import {
  type LoginMethod,
  type ProviderConnectSnapshot,
  type SaveApiKeyResult,
  providerConnectMachine,
  providerConnectSnapshot
} from "./provider-connect-machine.js"

export interface ConnectSheetDeviceCode {
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresInSeconds: number | null
}

/** What to connect: settings, onboarding and chat recovery all open the sheet with one of these. */
export interface ProviderConnectRequest {
  /** A fresh id adds an account; an existing one reconnects it. */
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly mode: "subscription" | "api-key"
  /** Locks the API key tab to this provider (reconnecting an API-key connection). */
  readonly apiProviderId?: ProviderId
}

export interface ProviderConnectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: ProviderConnectRequest
  deviceCode?: ConnectSheetDeviceCode | null
  /** Resolves once the provider confirms the connection; rejects with the reason it didn't. */
  onStartLogin: (method: LoginMethod) => Promise<void>
  /** Provider.cancelLogin for the in-flight login. */
  onCancelLogin: () => Promise<void>
  onReopenBrowser: () => void
  /** Provider.setApiKey + Provider.verifyModel; resolves ok or the rejection message. */
  onSaveApiKey: (providerId: string, apiKey: string) => Promise<SaveApiKeyResult>
  onConnected?: () => void
  /** Opens the sheet in a given machine state (stories). */
  snapshot?: ProviderConnectSnapshot
}

const API_PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const

const SUBSCRIPTION: Partial<Record<string, { label: string; plan: string; brand: string; methods: ReadonlyArray<LoginMethod> }>> = {
  anthropic: { label: "Claude Code", plan: "Claude Pro / Max", brand: "Claude", methods: ["claude-cli"] },
  "openai-codex": { label: "Codex", plan: "ChatGPT / Codex", brand: "ChatGPT", methods: ["browser", "device-code"] }
}

const apiProviderFor = (request: ProviderConnectRequest): string =>
  request.apiProviderId ??
  (request.providerId === "openai-codex" ? "openai" : API_PROVIDERS.find((id) => id === request.providerId) ?? "anthropic")

const apiProviderName = (id: string) => `${providerLabel(id as ProviderId)} API`

/** 480px Drawer for boards 15a–15c: subscription (Claude CLI / browser / device code) vs API key. */
export function ProviderConnectSheet(props: ProviderConnectSheetProps) {
  const label = SUBSCRIPTION[props.request.providerId]?.label ?? providerLabel(props.request.providerId)
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange}>
      <DrawerContent aria-label={`Connect ${label}`}>
        {/* Mounted only while open, so every open starts a fresh machine. */}
        <ConnectSheetBody {...props} />
      </DrawerContent>
    </Drawer>
  )
}

function ConnectSheetBody(props: ProviderConnectSheetProps) {
  const latest = useRef(props)
  latest.current = props
  const { request } = props
  const subscription = SUBSCRIPTION[request.providerId]
  const apiProvider = apiProviderFor(request)
  const machine = useMemo(
    () =>
      providerConnectMachine.provide({
        actors: {
          login: fromPromise(({ input }) => latest.current.onStartLogin(input.method)),
          cancelLogin: fromPromise(() => latest.current.onCancelLogin()),
          saveApiKey: fromPromise(({ input }) => latest.current.onSaveApiKey(input.providerId, input.apiKey))
        },
        actions: {
          reopenBrowser: () => latest.current.onReopenBrowser(),
          connected: () => latest.current.onConnected?.(),
          close: () => latest.current.onOpenChange(false)
        }
      }),
    []
  )
  const start =
    props.snapshot ??
    (request.mode === "api-key" || !subscription ? providerConnectSnapshot({ apiKey: "editing" }, { apiProvider }) : undefined)
  const [state, send, actor] = useMachine(machine, { input: { apiProvider }, ...(start ? { snapshot: start } : {}) })

  // Closing the sheet mid-login must not leave the provider login running.
  useEffect(
    () => () => {
      if (actor.getSnapshot().matches({ subscription: "connecting" })) void latest.current.onCancelLogin()
    },
    [actor]
  )

  const apiKeyMode = state.matches("apiKey")
  const label = subscription?.label ?? providerLabel(request.providerId)

  return (
    <>
      <div className="flex h-14 flex-none items-center border-b border-hairline px-6 pr-14">
        <DrawerTitle className="text-[15px] font-semibold leading-5 text-text-bright">
          {apiKeyMode ? "Connect with an API key" : `Connect ${label}`}
        </DrawerTitle>
        <DrawerDescription className="sr-only">Choose how Jingler should authenticate with this provider.</DrawerDescription>
      </div>
      <div className="flex flex-1 flex-col gap-5 overflow-auto p-6">
        {subscription && (
          <SegmentedControl
            fullWidth
            items={[
              { value: "subscription" as const, label: "Subscription" },
              { value: "api-key" as const, label: "API key" }
            ]}
            value={apiKeyMode ? "api-key" : "subscription"}
            onChange={(value) => send({ type: value === "api-key" ? "SELECT_API_KEY" : "SELECT_SUBSCRIPTION" })}
            aria-label="Connection method"
          />
        )}

        {apiKeyMode || !subscription ? (
          <ApiKeyCard
            apiProvider={state.context.apiProvider}
            locked={request.apiProviderId !== undefined}
            apiKey={state.context.apiKey}
            error={state.context.error}
            verifying={state.matches({ apiKey: "verifying" })}
            verified={state.matches({ apiKey: "verified" })}
            onProvider={(value) => send({ type: "EDIT_API_PROVIDER", value })}
            onChange={(value) => send({ type: "EDIT_API_KEY", value })}
            onSubmit={() => send({ type: "SUBMIT_API_KEY" })}
            onDone={() => send({ type: "DONE" })}
          />
        ) : (
          <SubscriptionPanel
            providerId={request.providerId}
            plan={subscription.plan}
            brand={subscription.brand}
            methods={subscription.methods}
            deviceCode={props.deviceCode ?? null}
            state={state}
            send={send}
          />
        )}
      </div>
    </>
  )
}

type SheetState = ReturnType<typeof useMachine<typeof providerConnectMachine>>[0]
type SheetSend = ReturnType<typeof useMachine<typeof providerConnectMachine>>[1]

function SubscriptionPanel({
  providerId,
  plan,
  brand,
  methods,
  deviceCode,
  state,
  send
}: {
  readonly providerId: ProviderId
  readonly plan: string
  readonly brand: string
  readonly methods: ReadonlyArray<LoginMethod>
  readonly deviceCode: ConnectSheetDeviceCode | null
  readonly state: SheetState
  readonly send: SheetSend
}) {
  const { method, error } = state.context
  const cli = methods.includes("claude-cli")
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface">
          <ProviderIcon providerId={providerId} size={18} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium leading-[18px] text-text-bright">{plan}</span>
          <span className="text-[12px] leading-[18px] text-muted-foreground">
            {cli ? (
              <>Uses your <code className="font-mono text-text">claude auth login</code>; Jingler never reads its credentials.</>
            ) : (
              `Sign in with your ${brand} subscription`
            )}
          </span>
        </div>
      </div>

      {state.matches({ subscription: "idle" }) ? (
        <StartButtons error={error} methods={methods} onStart={(next) => send({ type: "START", method: next })} />
      ) : (
        <Waiting
          method={method}
          deviceCode={deviceCode}
          brand={brand}
          cancelling={state.matches({ subscription: "cancelling" })}
          onReopen={() => send({ type: "REOPEN_BROWSER" })}
          onCancel={() => send({ type: "CANCEL" })}
        />
      )}

      <Callout tone="blue" glyph={<Lock size={14} />} className="items-start rounded-lg bg-panel p-3 text-[12px] leading-[18px]">
        A subscription connection never falls back to an API key.
      </Callout>
    </>
  )
}

const START_LABEL: Record<LoginMethod, string> = {
  "claude-cli": "Connect with Claude Code",
  browser: "Open browser",
  "device-code": "Use device code"
}

function StartButtons({
  error,
  methods,
  onStart
}: {
  readonly error: string | null
  readonly methods: ReadonlyArray<LoginMethod>
  readonly onStart: (method: LoginMethod) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Callout tone="red">
          {error}
          {methods.includes("claude-cli") && (
            <span className="mt-1 block text-muted-foreground">
              Run <code className="font-mono text-text">claude auth login</code> on this device, then try again.
            </span>
          )}
        </Callout>
      )}
      <div className="flex gap-2">
        {methods.map((method, index) => (
          <Button key={method} variant={index === 0 ? "primary" : "secondary"} onClick={() => onStart(method)}>
            {START_LABEL[method]}
          </Button>
        ))}
      </div>
    </div>
  )
}

const WAITING_COPY: Record<LoginMethod, (brand: string) => { title: string; body: string }> = {
  browser: (brand) => ({
    title: "Waiting for browser…",
    body: `Finish signing in to ${brand} in the browser window that just opened. Jingler continues when you're done.`
  }),
  "device-code": (brand) => ({
    title: "Requesting a device code…",
    body: `Jingler is asking ${brand} for a code to enter in your browser.`
  }),
  "claude-cli": () => ({
    title: "Checking Claude Code…",
    body: "Jingler is confirming your claude auth login and plan on this device."
  })
}

function Waiting({
  method,
  deviceCode,
  brand,
  cancelling,
  onReopen,
  onCancel
}: {
  readonly method: LoginMethod
  readonly deviceCode: ConnectSheetDeviceCode | null
  readonly brand: string
  readonly cancelling: boolean
  readonly onReopen: () => void
  readonly onCancel: () => void
}) {
  if (method === "device-code" && deviceCode) {
    return (
      <>
        <DeviceCodeBlock
          code={deviceCode.userCode}
          verificationUri={deviceCode.verificationUri}
          expiresInSeconds={deviceCode.expiresInSeconds}
          onReopenBrowser={onReopen}
          onCancel={onCancel}
        />
        <StatusRow icon={<Spinner size={14} />} className="px-1">
          Waiting for you to approve in the browser…
        </StatusRow>
      </>
    )
  }
  const { title, body } = WAITING_COPY[method](brand)
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-hairline bg-panel px-6 py-8 text-center">
      <Spinner size={28} />
      <div className="flex flex-col items-center gap-1">
        <span className="text-[15px] font-semibold leading-5 text-text-bright">{title}</span>
        <span className="max-w-80 text-[12px] leading-[18px] text-muted-foreground">{body}</span>
      </div>
      <div className="flex gap-2">
        {method === "browser" && (
          <Button variant="secondary" size="sm" onClick={onReopen} disabled={cancelling}>
            <ExternalLink size={14} /> Reopen browser
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={cancelling}>
          {cancelling && <Spinner size={12} />} Cancel
        </Button>
      </div>
    </div>
  )
}

function ApiKeyCard({
  apiProvider,
  locked,
  apiKey,
  error,
  verifying,
  verified,
  onProvider,
  onChange,
  onSubmit,
  onDone
}: {
  readonly apiProvider: string
  readonly locked: boolean
  readonly apiKey: string
  readonly error: string | null
  readonly verifying: boolean
  readonly verified: boolean
  readonly onProvider: (value: string) => void
  readonly onChange: (value: string) => void
  readonly onSubmit: () => void
  readonly onDone: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const options = locked ? [apiProvider] : API_PROVIDERS
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-hairline bg-panel p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (verified) onDone()
        else onSubmit()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Provider</span>
        <Select value={apiProvider} onValueChange={onProvider} disabled={locked || verifying || verified}>
          <SelectTrigger ariaLabel="API provider" className="h-8 bg-canvas px-2.5 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((id) => (
              <SelectItem key={id} value={id}>
                {apiProviderName(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Field
        label="API key"
        className="[&>label]:text-[12px] [&>label]:text-muted-foreground"
        error={
          error ? (
            <span className="flex items-center gap-1.5">
              <AlertCircle size={14} className="flex-none" /> {error}
            </span>
          ) : undefined
        }
        help={
          verified ? (
            <span className="flex items-center gap-1.5">
              <Check size={14} className="flex-none" /> Verified · {apiProviderName(apiProvider)}
            </span>
          ) : undefined
        }
      >
        {(control) => (
          <div className="relative">
            <Input
              {...control}
              type={revealed ? "text" : "password"}
              autoComplete="off"
              placeholder="Provider API key"
              value={apiKey}
              disabled={verifying || verified}
              onChange={(event) => onChange(event.target.value)}
              className="bg-canvas pr-9 font-mono text-[12px]"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={revealed ? "Hide key" : "Show key"}
              onClick={() => setRevealed((value) => !value)}
              className="absolute right-0.5 top-0.5 size-7 text-dim"
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
          </div>
        )}
      </Field>
      <div className="flex justify-end">
        {verified ? (
          <Button type="submit" variant="secondary">
            Done
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={verifying || apiKey.trim().length === 0}>
            {verifying && <Spinner size={13} />} {verifying ? "Testing…" : "Test & save"}
          </Button>
        )}
      </div>
    </form>
  )
}

export type { LoginMethod, SaveApiKeyResult }
