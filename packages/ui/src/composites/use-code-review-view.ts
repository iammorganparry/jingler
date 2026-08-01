import { useCallback } from "react"
import { useMachine } from "@xstate/react"
import {
  codeReviewViewMachine,
  type ReviewFileKind,
  type ReviewSheet
} from "./code-review-view-machine.js"

export function useCodeReviewView() {
  const [snapshot, send] = useMachine(codeReviewViewMachine)
  const { query, kind, feedbackOnly, collapseViewed, sheet } = snapshot.context

  return {
    query,
    kind,
    feedbackOnly,
    collapseViewed,
    sheet,
    focused: snapshot.matches({ presentation: "focused" }),
    docked: snapshot.matches({ layout: "docked" }),
    setQuery: useCallback((value: string) => send({ type: "SET_QUERY", query: value }), [send]),
    setKind: useCallback((value: ReviewFileKind) => send({ type: "SET_KIND", kind: value }), [send]),
    toggleFeedback: useCallback(() => send({ type: "TOGGLE_FEEDBACK" }), [send]),
    clearFeedback: useCallback(() => send({ type: "FEEDBACK_EMPTY" }), [send]),
    toggleCollapseViewed: useCallback(() => send({ type: "TOGGLE_COLLAPSE_VIEWED" }), [send]),
    clearFilters: useCallback(() => send({ type: "CLEAR_FILTERS" }), [send]),
    toggleFocus: useCallback(() => send({ type: "TOGGLE_FOCUS" }), [send]),
    toggleSheet: useCallback(
      (value: Exclude<ReviewSheet, null>) => send({ type: "TOGGLE_SHEET", sheet: value }),
      [send]
    ),
    dock: useCallback(() => send({ type: "DOCK" }), [send]),
    undock: useCallback(() => send({ type: "UNDOCK" }), [send])
  }
}
