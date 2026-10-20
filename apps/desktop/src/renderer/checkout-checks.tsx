/** Checks grouped by checkout for a multi-repo session; renders nothing for one checkout. */
import { useQueries } from "@tanstack/react-query"
import { checkoutsOf, type Session } from "@jingler/core"
import { PrCheckRow, checkoutLabel } from "@jingler/ui"
import { rpc } from "./rpc-client.js"

const CHECKOUT_CHECKS_MS = 10_000

export function CheckoutChecks({ session }: { readonly session: Session }) {
  const checkouts = checkoutsOf(session)
  const linked = checkouts.filter((checkout) => checkout.prNumber !== null)
  const prs = useQueries({
    queries: linked.map((checkout) => ({
      queryKey: ["github", "pr-checkout", session.id, checkout.id, checkout.prNumber] as const,
      queryFn: () => rpc.githubPr(session.id, undefined, checkout.id),
      enabled: checkouts.length > 1,
      refetchInterval: CHECKOUT_CHECKS_MS
    }))
  })
  if (checkouts.length < 2) return null
  return (
    <div data-testid="checkout-checks" className="flex flex-col gap-3 border-b border-line bg-panel px-4 py-3">
      {linked.map((checkout, i) => {
        const checks = prs[i]?.data?.checks ?? []
        return (
          <section key={checkout.id} data-testid={`checks-checkout-${checkout.id}`} className="flex flex-col gap-2">
            <h3 className="font-mono text-[10.5px] uppercase tracking-wide text-dim">
              {checkoutLabel(checkout)} · #{checkout.prNumber}
            </h3>
            {checks.length === 0 ? (
              <p className="text-[12px] text-dim">No checks reported.</p>
            ) : (
              checks.map((check) => <PrCheckRow key={check.name.toLowerCase()} check={check} />)
            )}
          </section>
        )
      })}
    </div>
  )
}
