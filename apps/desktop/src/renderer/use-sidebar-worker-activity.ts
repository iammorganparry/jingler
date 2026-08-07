import { useEffect, useMemo } from "react"
import { rpc } from "./rpc-client.js"
import { setSessionOrchestrationActivity } from "./session-activity.js"
import {
  foldSidebarWorkerActivity,
  orchestrationSessionActivity,
  type SidebarWorkerSnapshot
} from "./sidebar-worker-activity.js"

/**
 * Keep one worker subscription per session at app scope. Selecting a different
 * conversation no longer controls whether the sidebar learns about its workers.
 */
export const useSidebarWorkerActivity = (
  sessionIds: ReadonlyArray<string>
): void => {
  const sessionKey = useMemo(
    () => [...new Set(sessionIds)].sort().join("\u0000"),
    [sessionIds]
  )

  useEffect(() => {
    const ids = sessionKey.length === 0 ? [] : sessionKey.split("\u0000")
    const cleanups = ids.map((sessionId) => {
      let snapshot: SidebarWorkerSnapshot = {}
      let stopped = false
      let stopStream: (() => void) | null = null
      let reconnect: ReturnType<typeof setTimeout> | null = null

      const connect = (): void => {
        if (stopped) return
        stopStream = rpc.agentWatchSessionWorkers(
          sessionId,
          (activity) => {
            snapshot = foldSidebarWorkerActivity(snapshot, activity)
            setSessionOrchestrationActivity(
              sessionId,
              orchestrationSessionActivity(Object.values(snapshot))
            )
          },
          () => {
            if (stopped || reconnect !== null) return
            reconnect = setTimeout(() => {
              reconnect = null
              connect()
            }, 250)
          }
        )
      }

      connect()
      return () => {
        stopped = true
        stopStream?.()
        if (reconnect !== null) clearTimeout(reconnect)
        setSessionOrchestrationActivity(sessionId, null)
      }
    })
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [sessionKey])
}
