import { ProviderConnectionId, ProviderId } from "@jingler/core"
import { KeyRound } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"
import { ProviderIcon } from "../components/provider-icon.js"
import type { ProviderConnectRequest } from "./provider-connect-sheet.js"

export interface ProviderAuthFormsProps {
  busy?: boolean
  /** Opens the connect sheet (boards 15a–15c) for a new account. */
  onConnect: (request: ProviderConnectRequest) => void
}

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
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  )
}

const newRequest = (providerId: string, mode: ProviderConnectRequest["mode"]): ProviderConnectRequest => ({
  connectionId: ProviderConnectionId.make(crypto.randomUUID()),
  providerId: ProviderId.make(providerId),
  mode
})

/** Account picker for onboarding and Settings › Add runtime; each choice opens the connect sheet. */
export function ProviderAuthForms({ busy = false, onConnect }: ProviderAuthFormsProps) {
  return (
    <div className="flex flex-col divide-y divide-hairline">
      <AccountRow
        icon={<ProviderIcon providerId={ProviderId.make("anthropic")} size={16} />}
        name={<>Claude <span className="text-muted-foreground">Pro / Max</span></>}
        description={<>Uses your <code className="font-mono text-text">claude auth login</code>; Jingler never reads its credentials.</>}
      >
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onConnect(newRequest("anthropic", "subscription"))}>
          Connect Claude Code
        </Button>
      </AccountRow>
      <AccountRow
        icon={<ProviderIcon providerId={ProviderId.make("openai-codex")} size={17} />}
        name={<>Codex <span className="text-muted-foreground">with ChatGPT</span></>}
        description="Sign in through the browser or use a device code."
      >
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onConnect(newRequest("openai-codex", "subscription"))}>
          Connect Codex
        </Button>
      </AccountRow>
      <div className="py-2">
        <Button variant="ghost" size="sm" className="-ml-2" disabled={busy} onClick={() => onConnect(newRequest("anthropic", "api-key"))}>
          <KeyRound size={12} /> Use an API key instead
        </Button>
      </div>
    </div>
  )
}
