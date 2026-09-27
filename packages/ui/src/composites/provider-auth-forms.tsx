import type { AuthKind, CodexLoginMethod, ProviderId } from "@jingler/core"
import { useRef, useState } from "react"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { Spinner } from "../components/loading.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { ProviderIcon } from "../components/provider-icon.js"

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
           return (allows("claude-setup-token") && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-sunken p-3">
          <div className="flex items-center gap-2.5 text-[12.5px] font-medium text-text-bright">
            <span className="flex size-7 items-center justify-center rounded-md border border-line bg-canvas">
              <ProviderIcon providerId={"anthropic" as ProviderId} size={16} />
            </span>
            <span>
              Claude <span className="text-muted-foreground">Pro / Max</span>
            </span>
          </div>
          <p className="text-[11px] leading-[1.55] text-muted-foreground">
            Install Claude Code and run <code className="font-mono text-text">claude auth login</code>.
            Jingler uses that login for inference and never reads its credentials; usage shows what the CLI reports after each reply.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => onConnectClaude("claude-cli")}
              disabled={busy}
            >
              {isPending("claude-setup-token") && <Spinner size={13} />}
              {isPending("claude-setup-token")
                ? "Checking Claude CLI…"
                : mode === "reconnect"
                  ? "Reconnect Claude CLI"
                  : "Connect Claude through PI"}
            </Button>
          </div>
        </div>
      ))
         }

  const apiKey = useRef<HTMLInputElement>(null)
  const [apiProvider, setApiProvider] = useState("anthropic")
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
    <div className="flex flex-col gap-3">
      {renderClaudeSetup()}

      {allows("openai-codex-oauth") && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-sunken p-3">
          <div className="flex items-center gap-2.5 text-[12.5px] font-medium text-text-bright">
            <span className="flex size-7 items-center justify-center rounded-md border border-line bg-canvas">
              <ProviderIcon providerId={"openai-codex" as ProviderId} size={17} />
            </span>
            <span>
              Codex <span className="text-muted-foreground">with ChatGPT</span>
            </span>
          </div>
          <p className="text-[11px] leading-[1.55] text-muted-foreground">
            Sign in through the browser or use a device code. The main process owns polling and token storage.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => onStartCodex("browser")}
              disabled={busy}
            >
              {isPending("openai-codex-oauth") && <Spinner size={13} />}
              {isPending("openai-codex-oauth")
                ? "Connecting Codex…"
                : mode === "reconnect"
                  ? "Reconnect in browser"
                  : "Open browser"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => onStartCodex("device-code")}
              disabled={busy}
            >
              Use device code
            </Button>
          </div>
        </div>
      )}

      {allows("api-key") && (
        <details className="rounded-lg border border-line bg-sunken p-3">
          <summary className="cursor-pointer text-[12px] font-medium text-text-body">
            {mode === "reconnect" ? "Replace API key" : "Use an API key instead"}
          </summary>
          <div className="mt-3 flex gap-2">
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
            <Input
              ref={apiKey}
              type="password"
              autoComplete="off"
              placeholder="Provider API key"
              disabled={busy}
            />
            <Button variant="secondary" onClick={submitApiKey} disabled={busy}>
              {isPending("api-key") && <Spinner size={13} />}
              {isPending("api-key")
                ? "Saving API key…"
                : mode === "reconnect"
                  ? "Reconnect API key"
                  : "Save API key"}
            </Button>
          </div>
        </details>
      )}
    </div>
  )
}
