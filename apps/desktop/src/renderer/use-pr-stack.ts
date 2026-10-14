/**
 * Thin hook binding a session's PR stack to `prStackMachine`: which layer the PR
 * view shows, and the base-up layer list (live state shares the sidebar poll's
 * `pr-state` query cache). Returns `nav: undefined` for a single-PR session.
 */
import { useEffect, useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { useMachine } from "@xstate/react"
import type { Session } from "@jingler/core"
import type { PrStackNav } from "@jingler/ui"
import { prStackMachine } from "./pr-stack-machine.js"
import { prNumbersOf } from "./pr-sweep.js"
import { rpc } from "./rpc-client.js"

const PR_STATE_STALE_MS = 5 * 60_000

export function usePrStack(session: Session, connected: boolean): { selected: number | null; nav: PrStackNav | undefined } {
  const numbers = prNumbersOf(session)
  const key = numbers.join(",")
  const [snapshot, send] = useMachine(prStackMachine, { input: { numbers, current: session.prNumber ?? undefined } })
  useEffect(() => {
    send({ type: "STACK_CHANGED", numbers, current: session.prNumber ?? undefined })
    // `key` stands for `numbers`, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.prNumber, send])

  const statuses = useQueries({
    queries: numbers.map((number) => ({
      queryKey: ["pr-state", session.id, number] as const,
      queryFn: () => rpc.githubPrState(session.id, number),
      enabled: connected && numbers.length > 1,
      staleTime: PR_STATE_STALE_MS
    })),
    combine: (results) => results.map((result) => result.data)
  })

  const layers = useMemo(
    () =>
      numbers.map((number, index) => {
        const pr = session.prs?.find((candidate) => candidate.number === number)
        const status = statuses[index]
        return { number, branch: pr?.branch, state: status?.state ?? pr?.state, checks: status ? status.checks : pr?.checks }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, session.prs, statuses]
  )

  const nav = useMemo<PrStackNav | undefined>(
    () =>
      numbers.length > 1
        ? {
            layers,
            selected: snapshot.context.selected,
            onSelect: (number) => send({ type: "SELECT", number }),
            onStep: (delta) => send({ type: delta === 1 ? "NEXT" : "PREV" })
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, layers, snapshot.context.selected, send]
  )
  return { selected: snapshot.context.selected, nav }
}
