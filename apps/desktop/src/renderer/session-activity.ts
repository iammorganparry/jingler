/**
 * A tiny cross-component store of what each session's agent is *doing right now*
 * ("Running npm test", "Monitoring PR #482", "Needs input"). The conversation
 * registry writes to it from the actor's own subscription; the sidebar and tab
 * bar read it.
 *
 * Live-only by design: the persisted `Session.status` is a coarse lifecycle that
 * can't say what KIND of work is in flight. Absent here → the reader falls back
 * to that persisted status.
 */
import { useSyncExternalStore } from "react"
import type { SessionActivity } from "@jingler/core"

let activities: Record<string, SessionActivity> = {}
let conversationActivities: Record<string, SessionActivity> = {}
let orchestrationActivities: Record<string, SessionActivity> = {}
const listeners = new Set<() => void>()

const same = (a: SessionActivity | undefined, b: SessionActivity): boolean =>
  a?.kind === b.kind && a.verb === b.verb && a.target === b.target

const priority = (activity: SessionActivity): number => {
  if (activity.kind === "needs-input" || activity.kind === "needs-approval") return 3
  if (activity.kind === "delegating") return 2
  return 1
}

/** Combine independent live producers without letting background work hide a gate. */
export const selectSessionActivity = (
  conversation: SessionActivity | undefined,
  orchestration: SessionActivity | undefined
): SessionActivity | null => {
  if (conversation === undefined) return orchestration ?? null
  if (orchestration === undefined) return conversation
  return priority(orchestration) > priority(conversation) ? orchestration : conversation
}

const publish = (id: string): void => {
  const previous = activities[id]
  const next = selectSessionActivity(
    conversationActivities[id],
    orchestrationActivities[id]
  )
  if (next === null) {
    if (previous === undefined) return
    const remaining = { ...activities }
    delete remaining[id]
    activities = remaining
  } else {
    if (same(previous, next)) return
    activities = { ...activities, [id]: next }
  }
  for (const listener of listeners) listener()
}

const setSource = (
  source: "conversation" | "orchestration",
  id: string,
  activity: SessionActivity | null
): void => {
  const current = source === "conversation" ? conversationActivities : orchestrationActivities
  const next = { ...current }
  if (activity === null) delete next[id]
  else next[id] = activity
  if (source === "conversation") conversationActivities = next
  else orchestrationActivities = next
  publish(id)
}

/** Set (or clear, with `null`) a session's live activity; notifies subscribers. */
export const setSessionActivity = (id: string, activity: SessionActivity | null): void => {
  setSource("conversation", id, activity)
}

/** Publish plan-worker activity independently from the main conversation actor. */
export const setSessionOrchestrationActivity = (
  id: string,
  activity: SessionActivity | null
): void => setSource("orchestration", id, activity)

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live activities, keyed by session id. Absent → fall back to `Session.status`. */
export const useSessionActivities = (): Record<string, SessionActivity> =>
  useSyncExternalStore(
    subscribe,
    () => activities,
    () => activities
  )
