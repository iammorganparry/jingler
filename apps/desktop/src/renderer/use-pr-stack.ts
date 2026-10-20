/**
 * Thin hook binding a session's PR stack to `prStackMachine`: which layer the PR
 * view shows, and the base-up layer list (live state shares the sidebar poll's
 * `pr-state` query cache). Returns `nav: undefined` for a single-PR session.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { useMachine } from "@xstate/react"
import type { PrMergeMethod, Session } from "@jingler/core"
import type { PrStackNav } from "@jingler/ui"
import { prStackMachine } from "./pr-stack-machine.js"
import { prNumbersOf } from "./pr-sweep.js"
import { prKey } from "./use-pull-request.js"
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

  const qc = useQueryClient()
  const layersRef = useRef(layers)
  layersRef.current = layers

  // Merge stack base-up: one `Github.mergeBySlug` call per unmerged layer (the
  // existing per-PR merge path used by the PR inbox), sending LAYER_MERGED on
  // success so the machine advances, or MERGE_FAILED to stop the run at the
  // first failing layer. Lower layers are otherwise read-only — this is the
  // only write path that touches them.
  const onMergeStack = useCallback(() => {
    const slug = session.githubSlug
    if (!slug) return
    send({ type: "MERGE_STACK" })
    void (async () => {
      for (const layer of layersRef.current) {
        if (layer.state === "merged") continue
        try {
          await rpc.githubMergeBySlug(slug, layer.number, "merge" satisfies PrMergeMethod)
          void qc.invalidateQueries({ queryKey: ["pr-state", session.id, layer.number] })
          send({ type: "LAYER_MERGED" })
        } catch (cause) {
          send({ type: "MERGE_FAILED", message: (cause as { message?: string } | null)?.message ?? `Failed to merge #${layer.number}` })
          return
        }
      }
      void qc.invalidateQueries({ queryKey: prKey(session.id, session.prNumber) })
    })()
  }, [session.githubSlug, session.id, session.prNumber, qc, send])

  const nav = useMemo<PrStackNav | undefined>(
    () =>
      numbers.length > 1
        ? {
            layers,
            selected: snapshot.context.selected,
            onSelect: (number) => send({ type: "SELECT", number }),
            onStep: (delta) => send({ type: delta === 1 ? "NEXT" : "PREV" }),
            mergeState: snapshot.value as PrStackNav["mergeState"],
            merged: snapshot.context.merged,
            mergeError: snapshot.context.mergeError,
            onMergeStack
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, layers, snapshot.context.selected, snapshot.value, snapshot.context.merged, snapshot.context.mergeError, send, onMergeStack]
  )
  return { selected: snapshot.context.selected, nav }
}
