import { Clock, KeyRound } from "lucide-react"
import { useState } from "react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"
import { RuntimeRecoveryCard } from "./runtime-recovery-card.js"

/** Claude Code / Codex signed out mid-run: Reconnect opens the Connect sheet in place. */
export function ProviderSignedOutCard({
  title,
  message,
  onReconnect
}: {
  readonly title: string
  readonly message: string
  readonly onReconnect: () => void
}) {
  return (
    <RuntimeRecoveryCard
      label="Provider signed out"
      kind="Provider"
      title={title}
      message={message}
      icon={<KeyRound size={13} />}
      failed
      actionLabel="Reconnect"
      onAction={onReconnect}
    />
  )
}

/** Shown after a successful reconnect so the operator restarts the interrupted run. */
export function ProviderResumeCard({ onResume }: { readonly onResume: () => void }) {
  return (
    <RuntimeRecoveryCard
      label="Provider reconnected"
      kind="Provider"
      title="Signed back in"
      message="Your subscription is connected again. Resume the run where it stopped."
      icon={<KeyRound size={13} />}
      actionLabel="Resume run"
      onAction={onResume}
    />
  )
}

/** Usage limit: "Limited until 16:40" with a way out via another model or account. */
export function ProviderLimitBanner({
  limit,
  onSwitchModel,
  onSwitchAccount
}: {
  /** e.g. "Limited until 16:40" */
  readonly limit: string
  readonly onSwitchModel: () => void
  readonly onSwitchAccount: () => void
}) {
  return (
    <section aria-label="Usage limit" className="flex-none">
      <BannerShell
        placement="lane"
        icon={<Clock size={13} />}
        actions={[
          <Button key="model" variant="ghost" size="sm" onClick={onSwitchModel}>
            Switch model
          </Button>,
          <Button key="account" variant="secondary" size="sm" onClick={onSwitchAccount}>
            Switch account
          </Button>
        ]}
      >
        {limit}
      </BannerShell>
    </section>
  )
}

export interface ProviderAccountOption {
  readonly id: string
  readonly label: string
}

/** Several signed-in accounts could take over: the operator picks one; nothing is preselected. */
export function ProviderAccountChoice({
  accounts,
  onUse
}: {
  readonly accounts: ReadonlyArray<ProviderAccountOption>
  readonly onUse: (id: string) => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <section aria-label="Choose an account" className="flex-none border-b border-line px-3 py-2">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[11.5px] font-semibold text-text-bright">
          Choose the account for this conversation
        </legend>
        {accounts.map((account) => (
          <label key={account.id} className="flex items-center gap-2 text-[12px] text-text-bright">
            <input
              type="radio"
              name="provider-account"
              checked={picked === account.id}
              onChange={() => setPicked(account.id)}
            />
            {account.label}
          </label>
        ))}
      </fieldset>
      <Button
        className="mt-2"
        variant="secondary"
        size="sm"
        disabled={picked === null}
        onClick={() => picked !== null && onUse(picked)}
      >
        Use this account
      </Button>
    </section>
  )
}
