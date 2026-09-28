import { useCallback } from "react"
import { useMachine } from "@xstate/react"
import { codeReviewViewMachine, type ReviewFileKind } from "./code-review-view-machine.js"

export function useCodeReviewView() {
  const [snapshot, send] = useMachine(codeReviewViewMachine)
  const { query, kind, feedbackOnly, hideViewed } = snapshot.context

  return {
    query,
    kind,
    feedbackOnly,
    hideViewed,
    setQuery: useCallback((value: string) => send({ type: "SET_QUERY", query: value }), [send]),
    setKind: useCallback((value: ReviewFileKind) => send({ type: "SET_KIND", kind: value }), [send]),
    toggleFeedback: useCallback(() => send({ type: "TOGGLE_FEEDBACK" }), [send]),
    clearFeedback: useCallback(() => send({ type: "FEEDBACK_EMPTY" }), [send]),
    toggleHideViewed: useCallback(() => send({ type: "TOGGLE_HIDE_VIEWED" }), [send]),
    clearFilters: useCallback(() => send({ type: "CLEAR_FILTERS" }), [send])
  }
}
