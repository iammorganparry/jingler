/**
 * Session-header strip for a multi-repo session: the checkout switcher with one
 * live PR chip per checkout. Renders nothing for a legacy single-checkout session.
 */
import { useQueries } from "@tanstack/react-query"
import { checkoutsOf, type Session, type SessionPrStatus } from "@jingler/core"
import { CheckoutSwitcher } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"

const CHECKOUT_PR_STATE_MS = 30_000

export function CheckoutHeader({ session }: { readonly session: Session }) {
  const checkouts = checkoutsOf(session)
  const linked = checkouts.filter((checkout) => checkout.prNumber !== null)
  const prStates = useQueries({
    queries: linked.map((checkout) => ({
      queryKey: ["pr-state", session.id, checkout.id, checkout.prNumber] as const,
      queryFn: () => rpc.githubPrState(session.id, undefined, checkout.id),
      enabled: checkouts.length > 1,
      refetchInterval: CHECKOUT_PR_STATE_MS
    })),
    combine: (results) =>
      Object.fromEntries(linked.map((checkout, i) => [checkout.id, results[i]?.data])) as Record<
        string,
        SessionPrStatus | null | undefined
      >
  })
  return (
    <CheckoutSwitcher
      checkouts={checkouts}
      activeCheckoutId={session.activeCheckoutId ?? checkouts[0]?.id ?? ""}
      prStates={prStates}
      onSwitch={(checkoutId) => void rpc.sessionsSwitchCheckout(session.id, checkoutId).then(publishSessionUpdate)}
    />
  )
}
