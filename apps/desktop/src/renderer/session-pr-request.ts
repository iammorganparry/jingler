import { useSyncExternalStore } from "react"

// One-shot-ish "show this PR" request per session, set by the header PRs chip and read by PullRequestPane.
let requests: Readonly<Record<string, number>> = {}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

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
