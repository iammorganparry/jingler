/**
 * A tiny cross-component store of which sessions currently warrant a Plan Review
 * tab — i.e. the session has a streamed draft or a proposed plan in its transcript.
 * The conversation pane writes to it (it owns the live plan state); the tab bar
 * reads it to decide whether to surface the Plan tab. Mirrors `session-status.ts`.
 *
 * `Session.mode` in the app machine goes stale after a mid-session mode change,
 * so the tab can't key off it directly — this live signal fills that gap.
 */
import { useSyncExternalStore } from "react"

let present: Record<string, true> = {}
const listeners = new Set<() => void>()
const EMPTY: ReadonlySet<string> = new Set()
let snapshot: ReadonlySet<string> = EMPTY
const autoPresented = new Set<string>()

const recompute = () => {
  snapshot = new Set(Object.keys(present))
}

/** Mark (or clear) that a session has a Plan tab worth showing; notifies subscribers. */
export const setPlanPresent = (id: string, value: boolean): void => {
  const has = id in present
  if (value === has) return
  if (value) present = { ...present, [id]: true }
  else {
    const next = { ...present }
    delete next[id]
    present = next
  }
  recompute()
  for (const listener of listeners) listener()
}

/**
 * Claim the one automatic Plan Review presentation allowed for a session.
 *
 * Plan-draft presentation nonces are deliberately per turn, because each turn
 * can stream a fresh draft. The UI policy is broader: once a session has shown
 * its first plan, later amendments must respect an operator who closed the
 * split. Keeping that latch beside session-level plan presence also makes it
 * survive pane remounts and chat switches.
 */
export const claimPlanAutoPresentation = (id: string): boolean => {
  if (autoPresented.has(id)) return false
  autoPresented.add(id)
  return true
}

/** Forget presentation history when the session itself is permanently deleted. */
export const clearPlanAutoPresentation = (id: string): void => {
  autoPresented.delete(id)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The set of session ids that should show a Plan Review tab. */
export const usePlanSessions = (): ReadonlySet<string> =>
  useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
