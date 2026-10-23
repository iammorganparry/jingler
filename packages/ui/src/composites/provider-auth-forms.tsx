import type { AuthKind, CodexLoginMethod, ProviderId } from "@jingler/core"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"

export interface ProviderAuthFormsProps {
  busy: boolean
  mode?: "connect" | "reconnect"
  authKinds?: ReadonlyArray<AuthKind>
  apiProviderId?: ProviderId
  pendingAuthKind?: AuthKind | null
  onConnectClaude: (token: string) => void
  onStartCodex: (method: CodexLoginMethod) => void
  onConnectApi: (providerId: string, apiKey: string) => void
}

const ALL_AUTH_KINDS: ReadonlyArray<AuthKind> = [
  "claude-setup-token",
  "openai-codex-oauth",
  "api-key"
]

function AccountRow({
  icon,
  name,
  description,
  children
}: {
  readonly icon: ReactNode
  readonly name: ReactNode
  readonly description: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex size-7 flex-none items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text-bright">{name}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{description}</div>
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}

/** Shared credential-entry surface for onboarding and provider recovery. */
export function ProviderAuthForms({
  busy,
  mode = "connect",
  authKinds = ALL_AUTH_KINDS,
  apiProviderId,
  pendingAuthKind = null,
  onConnectClaude,
  onStartCodex,
  onConnectApi
}: ProviderAuthFormsProps) {
  function renderClaudeSetup() {
    return (
      allows("claude-setup-token") && (
        <AccountRow
          icon={<ProviderIcon providerId={"anthropic" as ProviderId} size={16} />}
          name={<>Claude <span className="text-muted-foreground">Pro / Max</span></>}
          description={<>Uses your <code className="font-mono text-text">claude auth login</code>; Jingler never reads its credentials.</>}
        >
          <Button variant="primary" size="sm" onClick={() => onConnectClaude("claude-cli")} disabled={busy}>
            {isPending("claude-setup-token") && <Spinner size={13} />}
            {isPending("claude-setup-token")
              ? "Checking Claude CLI…"
              : mode === "reconnect"
                ? "Reconnect Claude CLI"
                : "Connect Claude through PI"}
          </Button>
        </AccountRow>
      )
    )
  }

  const apiKey = useRef<HTMLInputElement>(null)
  const [apiProvider, setApiProvider] = useState("anthropic")
  const [apiOpen, setApiOpen] = useState(false)
  const allows = (kind: AuthKind) => authKinds.includes(kind)
  const isPending = (kind: AuthKind) => pendingAuthKind === kind

  const submitApiKey = () => {
    const key = apiKey.current?.value.trim() ?? ""
    const providerId = apiProviderId ?? apiProvider
    if (!key) return
    if (apiKey.current) apiKey.current.value = ""
    onConnectApi(providerId, key)
  }

  return (
    <div className="flex flex-col divide-y divide-hairline">
      {renderClaudeSetup()}

      {allows("openai-codex-oauth") && (
        <AccountRow
          icon={<ProviderIcon providerId={"openai-codex" as ProviderId} size={17} />}
          name={<>Codex <span className="text-muted-foreground">with ChatGPT</span></>}
          description="Sign in through the browser or use a device code."
        >
          <Button variant="secondary" size="sm" onClick={() => onStartCodex("device-code")} disabled={busy}>
            Use device code
          </Button>
          <Button variant="primary" size="sm" onClick={() => onStartCodex("browser")} disabled={busy}>
            {isPending("openai-codex-oauth") && <Spinner size={13} />}
            {isPending("openai-codex-oauth")
              ? "Connecting Codex…"
              : mode === "reconnect"
                ? "Reconnect in browser"
                : "Open browser"}
          </Button>
        </AccountRow>
      )}

      {allows("api-key") && (
        <div className="py-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={apiOpen}
            onClick={() => setApiOpen((v) => !v)}
            className="-ml-2"
          >
            <ChevronRight size={12} className={cn("transition-transform", apiOpen && "rotate-90")} />
            {mode === "reconnect" ? "Replace API key" : "Use an API key instead"}
          </Button>
          {apiOpen && (
            <div className="mt-2 flex gap-2">
              {apiProviderId === undefined && (
                <Select value={apiProvider} onValueChange={setApiProvider} disabled={busy} className="w-40">
                  <SelectTrigger ariaLabel="API provider" className="h-8 bg-canvas px-2 py-0 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">Anthropic API</SelectItem>
                    <SelectItem value="openai">OpenAI API</SelectItem>
                    <SelectItem value="google">Google API</SelectItem>
                    <SelectItem value="openrouter">OpenRouter API</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Input ref={apiKey} type="password" autoComplete="off" placeholder="Provider API key" disabled={busy} />
              <Button variant="secondary" onClick={submitApiKey} disabled={busy}>
                {isPending("api-key") && <Spinner size={13} />}
                {isPending("api-key")
                  ? "Saving API key…"
                  : mode === "reconnect"
                    ? "Reconnect API key"
                    : "Save API key"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
