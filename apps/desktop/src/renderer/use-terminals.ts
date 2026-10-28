/**
 * useTerminals — per-session terminal tab state for the renderer.
 *
 * Terminals are scoped to a session (their cwd is the session's worktree). The
 * PTYs themselves live in the main process and PERSIST across session switches
 * and dock toggles, so when a session becomes active we hydrate its tab strip
 * from `Terminal.list` (rather than respawning). Tabs are only really destroyed
 * by `close` (which kills the PTY). State is keyed by session id so switching
 * away and back restores the exact tab set.
 */
import { useCallback, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import type { TerminalInfo } from "@jingler/core"
import { rpc } from "./rpc-client.js"

const EMPTY_TABS: ReadonlyArray<TerminalInfo> = []

/** Stable react-query key for a session's persisted terminal list. */
const terminalsKey = (sessionId: string) => ["terminals", "list", sessionId] as const

/** Union two tab lists by id, keeping `primary` order then any extras. */
const mergeById = (
  primary: ReadonlyArray<TerminalInfo>,
  extra: ReadonlyArray<TerminalInfo>
): ReadonlyArray<TerminalInfo> => {
  const seen = new Set(primary.map((t) => t.id))
  return [...primary, ...extra.filter((t) => !seen.has(t.id))]
}

/**
 * React-query-backed hydration of a session's persisted terminals. The PTYs live
 * in the main process and outlive the renderer, so we fetch `Terminal.list` once
 * per session (staleTime/gcTime `Infinity`) and thereafter treat the query cache
 * as the source of truth — mutations write straight into it via `setQueryData`.
 * Keeping the cache forever is what lets switching away and back restore the exact
 * tab set. The `queryFn` re-merges any tabs created optimistically before the list
 * resolved, preserving the original create-during-hydration race guard.
 */
function useSessionTerminals(sessionId: string | null) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: terminalsKey(sessionId ?? ""),
    enabled: sessionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const list = await rpc.terminalList(sessionId!)
      const optimistic = qc.getQueryData<ReadonlyArray<TerminalInfo>>(terminalsKey(sessionId!)) ?? EMPTY_TABS
      return mergeById(list, optimistic)
    }
  })
}

/** Mutate a session's cached tab list in place (react-query is the store). */
const writeTabs = (
  qc: QueryClient,
  sessionId: string,
  update: (tabs: ReadonlyArray<TerminalInfo>) => ReadonlyArray<TerminalInfo>
): void => {
  qc.setQueryData<ReadonlyArray<TerminalInfo>>(terminalsKey(sessionId), (prev) => update(prev ?? EMPTY_TABS))
}

export interface UseTerminals {
  tabs: ReadonlyArray<TerminalInfo>
  /** True once this session's existing terminals have been loaded. */
  hydrated: boolean
  /** Spawn a new terminal for the active session; resolves its id. */
  create: () => Promise<string | null>
  /** Kill a terminal and drop its tab. */
  close: (id: string) => Promise<void>
  /** Replace a terminal with a fresh shell (spawn the new one first, then drop the old). */
  restart: (id: string) => Promise<string | null>
  /** Mark a tab exited (its shell process ended) — keeps it until closed. */
  markExited: (id: string, code: number) => void
}

export function useTerminals(sessionId: string | null, cwd?: string): UseTerminals {
  const qc = useQueryClient()
  const query = useSessionTerminals(sessionId)
  const creating = useRef(false)

  const tabs = query.data ?? EMPTY_TABS

  const create = useCallback(async () => {
    if (!sessionId || creating.current) return null
    creating.current = true
    try {
      const info = await rpc.terminalCreate(sessionId, cwd, 80, 24)
      writeTabs(qc, sessionId, (prev) => [...prev, info])
      return info.id
    } catch {
      return null // spawn failed; nothing added
    } finally {
      creating.current = false
    }
  }, [qc, sessionId, cwd])

  const close = useCallback(
    async (id: string) => {
      if (!sessionId) return
      await rpc.terminalKill(id).catch(() => {})
      writeTabs(qc, sessionId, (prev) => prev.filter((t) => t.id !== id))
    },
    [qc, sessionId]
  )

  const restart = useCallback(
    async (id: string) => {
      const next = await create()
      await close(id)
      return next
    },
    [create, close]
  )

  const markExited = useCallback(
    (id: string, code: number) => {
      if (!sessionId) return
      writeTabs(qc, sessionId, (prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "exited" as const, exitCode: code } : t))
      )
    },
    [qc, sessionId]
  )

  return {
    tabs,
    // `isFetched` flips true once the list settles (success or error), matching the
    // old behaviour of marking a session hydrated even when the list call failed.
    hydrated: sessionId !== null && query.isFetched,
    create,
    close,
    restart,
    markExited
  }
}
