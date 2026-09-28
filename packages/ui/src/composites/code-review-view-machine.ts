import { assign, setup } from "xstate"

export type ReviewFileKind = "all" | "code" | "tests" | "json" | "docs" | "styles"

/**
 * The changed-files Explorer's filters. Layout (docking, sheets, focus) left
 * with the stacked Changes view: the Explorer is the sidebar, and Focus is an
 * app-wide review flag, not this list's concern.
 */
export interface CodeReviewViewContext {
  readonly query: string
  readonly kind: ReviewFileKind
  readonly feedbackOnly: boolean
  /** Drop files already marked viewed, so the list shrinks to what's left. */
  readonly hideViewed: boolean
}

export type CodeReviewViewEvent =
  | { type: "SET_QUERY"; query: string }
  | { type: "SET_KIND"; kind: ReviewFileKind }
  | { type: "TOGGLE_FEEDBACK" }
  | { type: "FEEDBACK_EMPTY" }
  | { type: "TOGGLE_HIDE_VIEWED" }
  | { type: "CLEAR_FILTERS" }

export const codeReviewViewMachine = setup({
  types: {
    context: {} as CodeReviewViewContext,
    events: {} as CodeReviewViewEvent
  },
  actions: {
    setQuery: assign(({ event }) =>
      event.type === "SET_QUERY" ? { query: event.query } : {}
    ),
    setKind: assign(({ event }) =>
      event.type === "SET_KIND" ? { kind: event.kind } : {}
    ),
    toggleFeedback: assign(({ context }) => ({
      feedbackOnly: !context.feedbackOnly
    })),
    clearFeedback: assign(() => ({ feedbackOnly: false })),
    toggleHideViewed: assign(({ context }) => ({
      hideViewed: !context.hideViewed
    })),
    clearFilters: assign(() => ({
      query: "",
      kind: "all" as const,
      feedbackOnly: false,
      hideViewed: false
    }))
  }
}).createMachine({
  id: "codeReviewView",
  context: {
    query: "",
    kind: "all",
    feedbackOnly: false,
    hideViewed: false
  },
  on: {
    SET_QUERY: { actions: "setQuery" },
    SET_KIND: { actions: "setKind" },
    TOGGLE_FEEDBACK: { actions: "toggleFeedback" },
    FEEDBACK_EMPTY: { actions: "clearFeedback" },
    TOGGLE_HIDE_VIEWED: { actions: "toggleHideViewed" },
    CLEAR_FILTERS: { actions: "clearFilters" }
  }
})
