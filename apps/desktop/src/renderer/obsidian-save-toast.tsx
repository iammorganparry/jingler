import type { ExplanationDocument } from "@jingler/core"
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query"
import { Button } from "@jingler/ui"
import { useEffect, useRef, useState } from "react"
import { EXPLANATION_QUERY_ROOT } from "./use-explanation-document.js"
import { rpc } from "./rpc-client.js"

/** True once any session has an Obsidian vault (the plugin stores a `vault:<sessionId>` key each). */
export function useObsidianVaultConfigured(): boolean {
  const query = useQuery({
    queryKey: ["obsidian-vaults"],
    queryFn: () => rpc.pluginsStorageKeys("obsidian"),
    // A vault can be saved at any time from the plugin tab; keep Settings in step.
    refetchInterval: 5_000,
  })
  return query.data?.some((key) => key.startsWith("vault:")) ?? false
}

const keyOf = (document: ExplanationDocument | null | undefined): string =>
  document ? `${document.id}:${document.revision}` : ""

const sessionOf = (query: Query): string | null => {
  const [root, sessionId] = query.queryKey
  return root === EXPLANATION_QUERY_ROOT && typeof sessionId === "string" ? sessionId : null
}

/**
 * Saves each newly published explanation to Obsidian (the main process no-ops
 * when the setting is off) and surfaces a failure as a dismissible toast with
 * Retry. Runs in the renderer so a failed write can never touch the agent turn.
 */
export function ObsidianSaveToast() {
  const queryClient = useQueryClient()
  const seen = useRef(new Map<string, string>())
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())

  const save = (sessionId: string) =>
    rpc.explanationSaveToObsidian(sessionId).then(
      () => setFailures((current) => {
        if (!current.has(sessionId)) return current
        const next = new Map(current)
        next.delete(sessionId)
        return next
      }),
      (cause: unknown) => setFailures((current) => new Map(current).set(
        sessionId,
        cause instanceof Error ? cause.message : "Could not save the explanation to Obsidian."
      ))
    )

  useEffect(() => {
    const cache = queryClient.getQueryCache()
    // Documents already loaded are the baseline, not a fresh publish.
    for (const query of cache.findAll({ queryKey: [EXPLANATION_QUERY_ROOT] })) {
      const sessionId = sessionOf(query)
      if (sessionId !== null && query.state.status === "success") {
        seen.current.set(sessionId, keyOf(query.state.data as ExplanationDocument | null))
      }
    }
    return cache.subscribe((event) => {
      if (event.type !== "updated") return
      const sessionId = sessionOf(event.query)
      if (sessionId === null || event.query.state.status !== "success") return
      const key = keyOf(event.query.state.data as ExplanationDocument | null)
      const previous = seen.current.get(sessionId)
      seen.current.set(sessionId, key)
      if (previous !== undefined && previous !== key && key !== "") void save(sessionId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` only closes over stable setters.
  }, [queryClient])

  const [sessionId, message] = failures.entries().next().value ?? []
  if (sessionId === undefined) return null
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-sunken px-3 py-2 text-xs text-text shadow-lg"
    >
      <span>Couldn’t save the explanation to Obsidian. {message}</span>
      <Button size="sm" variant="secondary" onClick={() => void save(sessionId)}>Retry</Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setFailures((current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })}
      >
        Dismiss
      </Button>
    </div>
  )
}
