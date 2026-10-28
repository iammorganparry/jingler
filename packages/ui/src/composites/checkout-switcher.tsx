import type { SessionCheckout, SessionPrStatus } from "@jingler/core"
import { GitBranch } from "lucide-react"
import { ChipMenu, type ChipOption } from "../components/chip-menu.js"
import { cn } from "../lib/cn.js"
import { PrStatusGlyph } from "./pr-glyph.js"

const repoName = (repo: string): string => repo.split("/").filter(Boolean).at(-1) ?? repo

/** The `repo · branch` label one checkout carries everywhere it is named. */
export const checkoutLabel = (checkout: SessionCheckout): string => `${repoName(checkout.repo)} · ${checkout.branch}`

function CheckoutPrChip({
  checkout,
  prState
}: {
  readonly checkout: SessionCheckout
  readonly prState: SessionPrStatus | null | undefined
}) {
  if (checkout.prNumber === null) return null
  return (
    <span
      data-testid={`checkout-pr-${checkout.id}`}
      title={`${repoName(checkout.repo)} pull request #${checkout.prNumber}`}
      className="flex flex-none items-center gap-1 font-mono text-[10.5px] text-dim"
    >
      <PrStatusGlyph pr={prState ?? null} size={12} />#{checkout.prNumber}
    </span>
  )
}

/**
 * Session-header switcher for a multi-repo session: the active `repo · branch`
 * as a menu over every checkout, plus one PR chip per checkout. A legacy
 * single-checkout session renders nothing, so its header is unchanged.
 */
export function CheckoutSwitcher({
  checkouts,
  activeCheckoutId,
  prStates = {},
  onSwitch
}: {
  readonly checkouts: ReadonlyArray<SessionCheckout>
  readonly activeCheckoutId: string
  /** Live PR state keyed by checkout id. */
  readonly prStates?: Readonly<Record<string, SessionPrStatus | null | undefined>>
  readonly onSwitch?: (checkoutId: string) => void
}) {
  if (checkouts.length < 2) return null
  const options: ReadonlyArray<ChipOption<string>> = checkouts.map((checkout) => ({
    value: checkout.id,
    label: checkoutLabel(checkout),
    searchText: `${checkout.repo} ${checkout.branch}`
  }))
  const byId = new Map(checkouts.map((checkout) => [checkout.id, checkout]))
  return (
    <div data-testid="checkout-switcher" className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1">
      <ChipMenu
        value={activeCheckoutId}
        options={options}
        onSelect={onSwitch}
        disabled={onSwitch === undefined}
        icon={<GitBranch size={12} className="flex-none text-cyan" />}
        ariaLabel="Switch checkout"
        side="bottom"
        renderTrailing={(option) => {
          const checkout = byId.get(option.value)
          return checkout ? <CheckoutPrChip checkout={checkout} prState={prStates[checkout.id]} /> : null
        }}
      />
      {checkouts.map((checkout) => (
        <span
          key={checkout.id}
          data-testid={`checkout-chip-${checkout.id}`}
          className={cn("flex flex-none items-center gap-1 font-mono text-[10.5px]", checkout.id === activeCheckoutId ? "text-text-bright" : "text-dim")}
        >
          {repoName(checkout.repo)}
          <CheckoutPrChip checkout={checkout} prState={prStates[checkout.id]} />
        </span>
      ))}
    </div>
  )
}
