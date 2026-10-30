/**
 * Thin hook binding a session's PR stack to `prStackMachine`: which layer the PR
 * view shows, and the base-up layer list (live state shares the sidebar poll's
 * `pr-state` query cache). Returns `nav: undefined` for a single-PR session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { useMachine } from "@xstate/react"
import { activeCheckoutOf, checkoutPrsOf, conflictResolutionPrompt, type PrMergeMethod, type Session } from "@jingler/core"
import type { PrStackNav } from "@jingler/ui"
import { prStackMachine, type PrStackEvent } from "./pr-stack-machine.js"
import { prKey } from "./use-pull-request.js"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { rpcFailureTag, unwrapRpcFailure } from "./rpc-failure.js"

const PR_STATE_STALE_MS = 5 * 60_000

/** Run `call`; null on success, else the failure message (after `onError`). */
async function tryRpc(call: () => Promise<unknown>, fallback: string, onError?: (cause: unknown) => void): Promise<string | null> {
  try {
    await call()
    return null
  } catch (cause) {
    onError?.(cause)
    return onError ? fallback : ((cause as { message?: string } | null)?.message ?? fallback)
  }
}

/** Restack the layers above `mergedPr`; a rebase conflict is handed to the agent. Null on success. */
function restackAfter(session: Session, mergedPr: number): Promise<string | null> {
  return tryRpc(() => rpc.githubRestack(session.id, mergedPr), `Failed to restack after #${mergedPr}`, (cause) => {
    if (rpcFailureTag(cause) !== "RestackConflictError") return
    const { paths } = unwrapRpcFailure(cause) as { paths: ReadonlyArray<string> }
    getConversationActor(session).send({ type: "SEND", text: conflictResolutionPrompt(paths) })
  })
}

/** Merge one layer, then restack above it after a squash/rebase. Returns a failure message, else null. */
async function mergeLayer(args: {
  session: Session
  slug: string
  layer: { number: number; state?: string }
  method: PrMergeMethod
  hasUpper: boolean
  send: (event: PrStackEvent) => void
}): Promise<string | null> {
  const { session, slug, layer, method, hasUpper, send } = args
  const fresh = layer.state !== "merged"
  const failure = fresh ? await tryRpc(() => rpc.githubMergeBySlug(slug, layer.number, method), `Failed to merge #${layer.number}`) : null
  if (failure) return failure
  const needsRestack = fresh && method !== "merge" && hasUpper
  send({ type: "LAYER_MERGED", ...(needsRestack ? { restackAfter: layer.number } : {}) })
  if (!needsRestack) return null
  const restackFailure = await restackAfter(session, layer.number)
  if (restackFailure) return restackFailure
  send({ type: "RESTACK_DONE" })
  return null
}

export function usePrStack(session: Session, connected: boolean): { selected: number | null; nav: PrStackNav | undefined } {
  // The stack is the ACTIVE checkout's: merging or restacking never crosses repos.
  const checkout = activeCheckoutOf(session)
  const stackPrs = checkoutPrsOf(checkout)
  const numbers = stackPrs.map((pr) => pr.number)
  const key = `${checkout.id}:${numbers.join(",")}`
  const [snapshot, send] = useMachine(prStackMachine, { input: { numbers, current: checkout.prNumber ?? undefined } })
  useEffect(() => {
    send({ type: "STACK_CHANGED", numbers, current: checkout.prNumber ?? undefined })
    // `key` stands for `numbers`, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checkout.prNumber, send])

  const statuses = useQueries({
    queries: numbers.map((number) => ({
      queryKey: ["pr-state", session.id, checkout.id, number] as const,
      queryFn: () => rpc.githubPrState(session.id, number, checkout.id),
      enabled: connected && numbers.length > 1,
      staleTime: PR_STATE_STALE_MS
    })),
    combine: (results) => results.map((result) => result.data)
  })

  const layers = useMemo(
    () =>
      numbers.map((number, index) => {
        const pr = stackPrs.find((candidate) => candidate.number === number)
        const status = statuses[index]
        return { number, branch: pr?.branch, state: status?.state ?? pr?.state, checks: status ? status.checks : pr?.checks }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, session, statuses]
  )

  const qc = useQueryClient()
  const layersRef = useRef(layers)
  layersRef.current = layers

  // Merge stack base-up: one `Github.mergeBySlug` call per unmerged layer. After a
  // squash/rebase merge the layers above are restacked (`Github.restack`) before the
  // next merge. The first failure stops the run; Resume continues from that layer.
  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod>("merge")
  const run = useCallback(
    async (from: number) => {
      const slug = activeCheckoutOf(session).githubSlug
      if (!slug) return
      const all = layersRef.current
      for (const [index, layer] of all.slice(from).entries()) {
        const failure = await mergeLayer({ session, slug, layer, method: mergeMethod, hasUpper: from + index < all.length - 1, send })
        if (failure) return send({ type: "MERGE_FAILED", message: failure })
        await qc.invalidateQueries({ queryKey: ["pr-state", session.id] })
      }
      void qc.invalidateQueries({ queryKey: prKey(session.id, activeCheckoutOf(session).prNumber) })
    },
    [session, mergeMethod, qc, send]
  )
  const onMergeStack = useCallback(() => {
    const done = layersRef.current.findIndex((layer) => layer.state !== "merged")
    send({ type: "MERGE_STACK", merged: done < 0 ? layersRef.current.length : done })
    void run(Math.max(done, 0))
  }, [run, send])
  const mergedRef = useRef(0)
  mergedRef.current = snapshot.context.merged
  const onResume = useCallback(() => {
    send({ type: "RESUME" })
    void run(mergedRef.current)
  }, [run, send])

  // Restack after a base layer merged. A rebase conflict hands off to the agent
  // as a normal turn, the same path as "Ask agent to resolve conflicts".
  const [restacking, setRestacking] = useState(false)
  const onRestack = useCallback(
    (mergedPr: number) => {
      setRestacking(true)
      void rpc
        .githubRestack(session.id, mergedPr)
        .catch((cause: unknown) => {
          if (rpcFailureTag(cause) !== "RestackConflictError") return
          const { paths } = unwrapRpcFailure(cause) as { paths: ReadonlyArray<string> }
          getConversationActor(session).send({ type: "SEND", text: conflictResolutionPrompt(paths) })
        })
        .finally(() => {
          setRestacking(false)
          void qc.invalidateQueries({ queryKey: ["pr-state", session.id] })
        })
    },
    [session, qc]
  )

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
            onMergeStack,
            onResume,
            mergeMethod,
            onMergeMethod: setMergeMethod,
            restacking,
            onRestack
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, layers, snapshot.context.selected, snapshot.value, snapshot.context.merged, snapshot.context.mergeError, send, onMergeStack, onResume, mergeMethod, restacking, onRestack]
  )
  return { selected: snapshot.context.selected, nav }
}
