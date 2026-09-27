/**
 * Per-session review state shared by every surface that shows changes: the
 * Explorer's changed-files filter, the Files view's diff, and the review tray.
 *
 * It lives outside React because those surfaces mount independently (the
 * sidebar, a split pane, the tray beside the split) and must agree: a draft
 * written in the diff has to appear in the tray, and the filter chosen in the
 * Explorer decides which diff the Files view shows.
 */
import { useSyncExternalStore } from "react"
import { readViewedPaths, viewedStorageKey } from "./viewed-store.js"

/** Which files the Explorer lists: everything, or one diff source's changes. */
export type ReviewFilter = "all" | "local" | "pr"

export interface ReviewDraft {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly endLine: number | null
  readonly body: string
  readonly routeToAgent: boolean
}

export interface SessionReviewState {
  readonly filter: ReviewFilter
  readonly drafts: ReadonlyArray<ReviewDraft>
  readonly viewed: ReadonlySet<string>
}

const states = new Map<string, SessionReviewState>()
const listeners = new Set<() => void>()
let draftSeq = 0

/** Viewed markers are per PR, so the store is keyed by session AND PR. */
const storeKey = (sessionId: string, prNumber: number | null): string =>
  `${sessionId}\0${prNumber ?? "none"}`

const read = (sessionId: string, prNumber: number | null): SessionReviewState => {
  const key = storeKey(sessionId, prNumber)
  const existing = states.get(key)
  if (existing !== undefined) return existing
  const initial: SessionReviewState = {
    filter: "all",
    drafts: [],
    viewed: readViewedPaths(sessionId, prNumber)
  }
  states.set(key, initial)
  return initial
}

const update = (
  sessionId: string,
  prNumber: number | null,
  change: (state: SessionReviewState) => SessionReviewState
): void => {
  const current = read(sessionId, prNumber)
  const next = change(current)
  if (next === current) return
  states.set(storeKey(sessionId, prNumber), next)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSessionReviewState = (
  sessionId: string,
  prNumber: number | null
): SessionReviewState =>
  useSyncExternalStore(subscribe, () => read(sessionId, prNumber))

export const setReviewFilter = (
  sessionId: string,
  prNumber: number | null,
  filter: ReviewFilter
): void =>
  update(sessionId, prNumber, (state) =>
    state.filter === filter ? state : { ...state, filter }
  )

/**
 * Review Focus: only the diff keeps the width — the workspace sidebar and the
 * review tray step aside. App-wide, because the sidebar it collapses is.
 */
let focused = false

export const useReviewFocused = (): boolean => useSyncExternalStore(subscribe, () => focused)

export const setReviewFocused = (next: boolean): void => {
  if (focused === next) return
  focused = next
  for (const listener of listeners) listener()
}

export const addReviewDraft = (
  sessionId: string,
  prNumber: number | null,
  draft: Omit<ReviewDraft, "id">
): void => {
  draftSeq += 1
  const id = `d_${draftSeq}`
  update(sessionId, prNumber, (state) => ({
    ...state,
    drafts: [...state.drafts, { id, ...draft }]
  }))
}

export const removeReviewDraft = (
  sessionId: string,
  prNumber: number | null,
  id: string
): void =>
  update(sessionId, prNumber, (state) =>
    state.drafts.some((draft) => draft.id === id)
      ? { ...state, drafts: state.drafts.filter((draft) => draft.id !== id) }
      : state
  )

export const clearReviewDrafts = (sessionId: string, prNumber: number | null): void =>
  update(sessionId, prNumber, (state) =>
    state.drafts.length === 0 ? state : { ...state, drafts: [] }
  )

/** "Viewed" is reviewer-local (git and GitHub don't report it), so it persists here. */
export const setReviewViewed = (
  sessionId: string,
  prNumber: number | null,
  path: string,
  viewed: boolean
): void =>
  update(sessionId, prNumber, (state) => {
    if (state.viewed.has(path) === viewed) return state
    const next = new Set(state.viewed)
    if (viewed) next.add(path)
    else next.delete(path)
    try {
      localStorage.setItem(viewedStorageKey(sessionId, prNumber), JSON.stringify([...next]))
    } catch {
      /* storage unavailable: the marker still holds for this run */
    }
    return { ...state, viewed: next }
  })

/** Test seam: forget every session's review state. */
export const resetReviewStore = (): void => {
  states.clear()
  draftSeq = 0
  focused = false
  for (const listener of listeners) listener()
}
