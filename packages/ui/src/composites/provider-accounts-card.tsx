import type { ProviderId } from "@jingler/core"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { AlertTriangle, Copy, MoreHorizontal, Plus, RefreshCw, Star } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Pill } from "../components/pill.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"

export interface ProviderAccount {
  readonly id: string
  readonly label: string
  readonly plan: string | null
}

const STATUS = {
  ready: { label: "Ready", tone: "green" },
  "needs-attention": { label: "Needs attention", tone: "yellow" },
  native: { label: "Native", tone: "blue" }
} as const

const menuItemClass =
  "flex h-8 cursor-default items-center rounded-md px-2.5 text-[12px] text-text outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"

function AccountMenu({ label, items }: { label: string; items: ReadonlyArray<{ label: string; onSelect: () => void; danger?: boolean }> }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${label} actions`} className="size-7 text-dim">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 flex min-w-40 flex-col rounded-lg border border-line bg-sunken p-1 shadow-2xl">
          {items.map((item) => (
            <DropdownMenu.Item key={item.label} onSelect={item.onSelect} className={cn(menuItemClass, item.danger && "text-state-failed")}>
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Board 15d: one runtime's card — header, account rows (default star, ⋯), and an optional footer slot. */
export function ProviderAccountsCard({
  providerId,
  name,
  status,
  detail,
  trailing,
  accounts = [],
  defaultAccountId = null,
  onMakeDefault,
  onSignOut,
  onAddAccount,
  selectedAccountId = null,
  onSelectAccount,
  children
}: {
  readonly providerId: ProviderId
  readonly name: string
  readonly status: keyof typeof STATUS
  readonly detail: string
  /** Header right side, e.g. the default-model select or a ⋯ menu. */
  readonly trailing?: ReactNode
  readonly accounts?: ReadonlyArray<ProviderAccount>
  readonly defaultAccountId?: string | null
  readonly onMakeDefault?: (accountId: string) => void
  readonly onSignOut?: (accountId: string) => void
  readonly onAddAccount?: () => void
  /** Highlights the account whose details show below the cards. */
  readonly selectedAccountId?: string | null
  readonly onSelectAccount?: (accountId: string) => void
  /** Warning or hint below the header (`EntitlementWarning`, `NativeLoginHint`). */
  readonly children?: ReactNode
}) {
  const { label, tone } = STATUS[status]
  return (
    <section
      aria-label={name}
      className={cn("flex flex-col rounded-xl border bg-editor", status === "needs-attention" ? "border-yellow/40" : "border-hairline")}
    >
      <div className="flex items-center gap-3 p-4">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface">
          <ProviderIcon providerId={providerId} size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium leading-[18px] text-text-bright">{name}</span>
            <Pill tone={tone}>{label}</Pill>
          </div>
          <span className="truncate text-[12px] leading-[18px] text-muted-foreground">{detail}</span>
        </div>
        {trailing}
      </div>
      {accounts.map((account) => {
        const isDefault = account.id === defaultAccountId
        return (
          <div key={account.id} className="flex h-11 items-center gap-2.5 border-t border-hairline px-4">
            <Star
              size={14}
              aria-label={isDefault ? "Default account" : undefined}
              aria-hidden={!isDefault}
              className={cn("flex-none", isDefault ? "fill-text-bright text-text-bright" : "text-dim")}
            />
            {onSelectAccount ? (
              <button
                type="button"
                aria-pressed={account.id === selectedAccountId}
                onClick={() => onSelectAccount(account.id)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-[13px] text-text-bright outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                  account.id === selectedAccountId && "bg-hover"
                )}
              >
                {account.label}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-[13px] text-text-bright">{account.label}</span>
            )}
            <span className="flex-none text-[11px] text-dim">
              {[isDefault ? "Default" : null, account.plan].filter(Boolean).join(" · ")}
            </span>
            <AccountMenu
              label={account.label}
              items={[
                ...(isDefault || !onMakeDefault ? [] : [{ label: "Make default", onSelect: () => onMakeDefault(account.id) }]),
                ...(onSignOut ? [{ label: "Sign out", onSelect: () => onSignOut(account.id), danger: true }] : [])
              ]}
            />
          </div>
        )
      })}
      {onAddAccount && (
        <div className="flex h-10 items-center border-t border-hairline px-2">
          <Button variant="ghost" size="sm" onClick={onAddAccount}>
            <Plus size={14} /> Add another account
          </Button>
        </div>
      )}
      {children && <div className="px-4 pb-4">{children}</div>}
    </section>
  )
}

/** 15d amber notice: signed in, but the plan couldn't be confirmed. */
export function EntitlementWarning({ message, onRetry, onUseAnother }: { message: string; onRetry: () => void; onUseAnother: () => void }) {
  return (
    <Callout tone="yellow" glyph={<AlertTriangle size={14} className="text-yellow" />} className="rounded-lg bg-editor p-3 text-[12px] [&>span:last-child]:flex-1">
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 leading-[18px] text-text-bright">{message}</span>
        <Button variant="secondary" size="sm" onClick={onRetry}>Retry check</Button>
        <Button variant="ghost" size="sm" onClick={onUseAnother}>Use another account</Button>
      </span>
    </Callout>
  )
}

/** 15d native-login hint: run the CLI's own login, then refresh runtimes. */
export function NativeLoginHint({ command, onRefresh }: { command: string; onRefresh: () => void }) {
  const copy = () => {
    navigator.clipboard.writeText(command).catch(() => {})
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-panel py-2 pl-3 pr-2 text-[12px] leading-[18px] text-muted-foreground">
      <span>Run</span>
      <code className="select-all rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-text-bright">{command}</code>
      <span className="min-w-0 flex-1">on this device, then refresh runtimes</span>
      <Button variant="ghost" size="icon" aria-label="Copy command" onClick={copy} className="size-7">
        <Copy size={14} />
      </Button>
      <Button variant="secondary" size="sm" onClick={onRefresh}>
        <RefreshCw size={14} /> Refresh
      </Button>
    </div>
  )
}
