import { useSyncExternalStore } from "react"
import type { SessionActivity } from "@jingler/core"

/** Live activity published by each selected workspace agent. */
let activities: Record<string, SessionActivity> = {}
const listeners = new Set<() => void>()

const same = (a: SessionActivity | undefined, b: SessionActivity): boolean =>
  a?.kind === b.kind && a.verb === b.verb && a.target === b.target

/** Set or clear one workspace's live activity and notify sidebar subscribers. */
export const setSessionActivity = (id: string, activity: SessionActivity | null): void => {
  const previous = activities[id]
  if (activity === null) {
    if (previous === undefined) return
    const next = { ...activities }
    delete next[id]
    activities = next
  } else {
    if (same(previous, activity)) return
    activities = { ...activities, [id]: activity }
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSessionActivities = (): Record<string, SessionActivity> =>
  useSyncExternalStore(subscribe, () => activities, () => activities)
