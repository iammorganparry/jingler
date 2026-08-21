import type { ExplanationDocument, Session } from "@jingler/core"
import {
  queryOptions,
  useQueries,
  useQuery,
  type Query,
  type QueryClient
} from "@tanstack/react-query"
import { rpc } from "./rpc-client.js"

const EXPLANATION_QUERY_ROOT = "explanation-document"

export const explanationQueryKey = (sessionId: string) =>
  [EXPLANATION_QUERY_ROOT, sessionId] as const

const explanationQueryOptions = (sessionId: string) => queryOptions({
  queryKey: explanationQueryKey(sessionId),
  queryFn: () => rpc.explanationCurrent(sessionId),
  staleTime: Infinity
})

const sessionIdFor = (query: Query): string | null => {
  const [root, sessionId] = query.queryKey
  return root === EXPLANATION_QUERY_ROOT && typeof sessionId === "string"
    ? sessionId
    : null
}

const installed = new WeakMap<QueryClient, () => void>()

/** Keep live IPC subscriptions aligned with active React Query observers. */
export const installExplanationQueryBridge = (queryClient: QueryClient): (() => void) => {
  const existing = installed.get(queryClient)
  if (existing) return existing

  const watchers = new Map<string, { readonly token: symbol; readonly stop: () => void }>()
  const stopWatch = (sessionId: string): void => {
    const watcher = watchers.get(sessionId)
    watchers.delete(sessionId)
    watcher?.stop()
  }
  const startWatch = (query: Query): void => {
    const sessionId = sessionIdFor(query)
    if (
      sessionId === null ||
      query.getObserversCount() === 0 ||
      query.state.status !== "success" ||
      watchers.has(sessionId)
    ) return
    const token = Symbol(sessionId)
    watchers.set(sessionId, { token, stop: () => {} })
    try {
      const stop = rpc.explanationWatch(sessionId, (document) => {
        if (watchers.get(sessionId)?.token !== token) return
        queryClient.setQueryData<ExplanationDocument | null>(
          explanationQueryKey(sessionId),
          (current) => {
            if (
              current !== null &&
              current !== undefined &&
              document !== null &&
              current.id === document.id &&
              current.revision > document.revision
            ) return current
            return document
          }
        )
      })
      if (watchers.get(sessionId)?.token !== token || query.getObserversCount() === 0) {
        stop()
        return
      }
      watchers.set(sessionId, { token, stop })
    } catch {
      if (watchers.get(sessionId)?.token === token) watchers.delete(sessionId)
    }
  }

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const sessionId = sessionIdFor(event.query)
    if (sessionId === null) return
    if (event.type === "observerRemoved" || event.type === "removed") {
      if (event.query.getObserversCount() === 0) stopWatch(sessionId)
      return
    }
    if (event.type === "observerAdded" || event.type === "updated") startWatch(event.query)
  })

  const dispose = () => {
    unsubscribe()
    for (const watcher of watchers.values()) watcher.stop()
    watchers.clear()
    installed.delete(queryClient)
  }
  installed.set(queryClient, dispose)
  return dispose
}

export function useExplanationDocument(sessionId: string) {
  const query = useQuery(explanationQueryOptions(sessionId))
  return {
    document: query.data ?? null,
    error: query.error instanceof Error ? query.error.message : null,
    loading: query.isPending,
    retry: () => { void query.refetch() }
  }
}

export function useExplanationSessions(sessions: ReadonlyArray<Session>): ReadonlySet<string> {
  const results = useQueries({
    queries: sessions.map((session) => explanationQueryOptions(session.id))
  })
  return new Set(
    sessions.flatMap((session, index) => {
      const document = results[index]?.data
      return document === undefined || document === null ? [] : [session.id]
    })
  )
}
