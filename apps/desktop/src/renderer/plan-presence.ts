/**
 * A tiny cross-component store of which sessions currently warrant a Plan Review
 * tab — i.e. the session has an active embedded Plannotator review.
 * The conversation pane writes to it (it owns the live plan state); the tab bar
 * reads it to decide whether to surface the Plan tab. Mirrors `session-status.ts`.
 *
 * `Session.mode` in the app machine goes stale after a mid-session mode change,
 * so the tab can't key off it directly — this live signal fills that gap.
 */
import { useSyncExternalStore } from "react"

let present: Record<string, true> = {}
let disconnected: Record<string, true> = {}
const listeners = new Set<() => void>()
const EMPTY: ReadonlySet<string> = new Set()
let snapshot: ReadonlySet<string> = EMPTY
const autoPresented = new Map<string, string>()

export const planAutoPresentationStorageKey = (id: string): string =>
  `sb.plan.auto-presented.${id}`

const wasAutoPresented = (id: string, reviewId: string): boolean => {
  if (autoPresented.get(id) === reviewId) return true
  try {
    if (localStorage.getItem(planAutoPresentationStorageKey(id)) !== reviewId) return false
    autoPresented.set(id, reviewId)
    return true
  } catch {
    // Storage can be unavailable in private/quota-limited renderers. The
    // process-local latch still preserves the policy for the current run.
    return false
  }
}

const recompute = () => {
  snapshot = new Set([...Object.keys(present), ...Object.keys(disconnected)])
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
 * Mark (or clear) that a chat's Plannotator review was interrupted by a host restart. A
 * disconnected chat keeps its Plan tab so the "Reopen" card has somewhere to live.
 */
export const setPlanDisconnected = (id: string, value: boolean): void => {
  if (value === id in disconnected) return
  if (value) disconnected = { ...disconnected, [id]: true }
  else {
    const next = { ...disconnected }
    delete next[id]
    disconnected = next
  }
  recompute()
  for (const listener of listeners) listener()
}

/** Whether the chat's Plannotator review needs reopening. */
export const usePlanDisconnected = (id: string): boolean =>
  useSyncExternalStore(
    subscribe,
    () => id in disconnected,
    () => id in disconnected
  )

/**
 * Claim one automatic presentation for a review. A new blocking review must
 * always open, while remounting the same review respects an operator who closed it.
 */
export const claimPlanAutoPresentation = (id: string, reviewId: string): boolean => {
  if (wasAutoPresented(id, reviewId)) return false
  autoPresented.set(id, reviewId)
  try {
    localStorage.setItem(planAutoPresentationStorageKey(id), reviewId)
  } catch {
    // The in-memory claim above is still authoritative for this renderer run.
  }
  return true
}

/** Forget presentation history when the session itself is permanently deleted. */
export const clearPlanAutoPresentation = (id: string): void => {
  autoPresented.delete(id)
  try {
    localStorage.removeItem(planAutoPresentationStorageKey(id))
  } catch {
    // There is no persisted state to clean up when storage is unavailable.
  }
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
