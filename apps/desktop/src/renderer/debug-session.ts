import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DebugControlAction, DebugViewSnapshot } from "@jingler/core"

interface DebugHover { readonly expression: string; readonly frameId?: number }
import { pluginBridge } from "./plugin-bridge.js"

const INTERVAL_MS = 700
const EMPTY: DebugViewSnapshot = { active: false, session: null, scopes: [], variables: {}, actions: [], error: null }

export const useDebugSessions = (
  sessionIds: readonly string[],
  visibleSessionIds: readonly string[],
  enabled: boolean,
  wakeKey = ""
): Readonly<Record<string, DebugViewSnapshot>> => {
  const [snapshots, setSnapshots] = useState<Readonly<Record<string, DebugViewSnapshot>>>({})
  const activeIds = useRef<ReadonlySet<string>>(new Set())
  const sessionKey = sessionIds.join("\0")
  const visibleKey = visibleSessionIds.join("\0")
  const ids = useMemo(() => sessionKey === "" ? [] : sessionKey.split("\0"), [sessionKey])
  const visibleIds = useMemo(() => visibleKey === "" ? [] : visibleKey.split("\0"), [visibleKey])
  // wakeKey is a signal: changed agent activity retries visible inactive sessions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signal intentionally has no value-level use
  useEffect(() => {
    if (!enabled) {
      activeIds.current = new Set()
      setSnapshots({})
      return
    }
    const existing = new Set(ids)
    const visible = new Set(visibleIds)
    const polling = [...new Set([...visibleIds, ...[...activeIds.current].filter((id) => existing.has(id))])]
    if (polling.length === 0) {
      setSnapshots({})
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bridge = pluginBridge("debug")
    const poll = async () => {
      const entries = await Promise.all(polling.map(async (sessionId) => {
        try {
          return [sessionId, await bridge.invoke<DebugViewSnapshot>("debug.snapshot", { sessionId })] as const
        } catch {
          return [sessionId, EMPTY] as const
        }
      }))
      if (!cancelled) {
        activeIds.current = new Set(entries.filter(([, snapshot]) => snapshot.active).map(([sessionId]) => sessionId))
        setSnapshots(Object.fromEntries(entries.filter(([sessionId, snapshot]) => visible.has(sessionId) || snapshot.active)))
        if (activeIds.current.size > 0) timer = setTimeout(poll, INTERVAL_MS)
      }
    }
    poll().catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, ids, visibleIds, wakeKey])
  return snapshots
}

export interface DebugSessionModel {
  readonly snapshot: DebugViewSnapshot
  readonly control: (action: DebugControlAction) => Promise<void>
  readonly hover: (input: DebugHover) => Promise<{ result?: string; type?: string; variablesReference?: number }>
}

export const useDebugSessionModel = (
  sessionId: string,
  snapshot: DebugViewSnapshot | undefined
): DebugSessionModel => {
  const bridge = useMemo(() => pluginBridge("debug"), [])
  const latest = useRef(snapshot ?? EMPTY)
  latest.current = snapshot ?? EMPTY
  const control = useCallback(async (action: DebugControlAction) => {
    await bridge.invoke("debug.control", { sessionId, action })
  }, [bridge, sessionId])
  const hover = useCallback(async (input: DebugHover) =>
    bridge.invoke<{ result?: string; type?: string; variablesReference?: number }>("debug.hover", { sessionId, ...input }), [bridge, sessionId])
  return { snapshot: latest.current, control, hover }
}
