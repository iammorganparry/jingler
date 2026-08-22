import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DebugControlAction, DebugViewSnapshot } from "@jingler/core"

interface DebugHover { readonly expression: string; readonly frameId?: number }
import { pluginBridge } from "./plugin-bridge.js"

const INTERVAL_MS = 700
const EMPTY: DebugViewSnapshot = { active: false, session: null, scopes: [], variables: {}, actions: [], error: null }

export const useDebugSessions = (
  sessionIds: readonly string[],
  enabled: boolean
): Readonly<Record<string, DebugViewSnapshot>> => {
  const [snapshots, setSnapshots] = useState<Readonly<Record<string, DebugViewSnapshot>>>({})
  const key = sessionIds.join("\0")
  const ids = useMemo(() => key === "" ? [] : key.split("\0"), [key])
  useEffect(() => {
    if (!enabled || ids.length === 0) {
      setSnapshots({})
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bridge = pluginBridge("debug")
    const poll = async () => {
      const entries = await Promise.all(ids.map(async (sessionId) => {
        try {
          return [sessionId, await bridge.invoke<DebugViewSnapshot>("debug.snapshot", { sessionId })] as const
        } catch {
          return [sessionId, EMPTY] as const
        }
      }))
      if (!cancelled) {
        setSnapshots((current) => {
          const next = Object.fromEntries(entries)
          return JSON.stringify(current) === JSON.stringify(next) ? current : next
        })
        timer = setTimeout(poll, INTERVAL_MS)
      }
    }
    poll().catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, ids])
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
