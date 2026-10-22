import { useSyncExternalStore } from "react"

// One-shot-ish "show this PR" request per session, set by the header PRs chip and read by PullRequestPane.
let requests: Readonly<Record<string, number>> = {}
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const requestSessionPr = (sessionId: string, prNumber: number): void => {
  requests = { ...requests, [sessionId]: prNumber }
  emit()
}

export const clearSessionPrRequest = (sessionId: string): void => {
  if (requests[sessionId] === undefined) return
  const { [sessionId]: _dropped, ...rest } = requests
  requests = rest
  emit()
}

export const useSessionPrRequest = (sessionId: string): number | undefined =>
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => requests[sessionId])

/** ⌥[ / ⌥] step from the PR on screen: a chip-requested PR overrides the machine's selection, so sync it first and drop the request. */
export const stepFromShownPr = (
  sessionId: string,
  shownPr: number | null,
  nav: { onSelect: (n: number) => void; onStep: (delta: -1 | 1) => void } | undefined,
  delta: -1 | 1
): void => {
  clearSessionPrRequest(sessionId)
  if (shownPr !== null) nav?.onSelect(shownPr)
  nav?.onStep(delta)
}
