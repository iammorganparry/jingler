import { assign, setup } from "xstate"

export type ReviewFileKind = "all" | "code" | "tests" | "json" | "docs" | "styles"
export type ReviewSheet = "files" | "tray" | null

export interface CodeReviewViewContext {
  readonly query: string
  readonly kind: ReviewFileKind
  readonly feedbackOnly: boolean
  readonly collapseViewed: boolean
  readonly sheet: ReviewSheet
}

export type CodeReviewViewEvent =
  | { type: "SET_QUERY"; query: string }
  | { type: "SET_KIND"; kind: ReviewFileKind }
  | { type: "TOGGLE_FEEDBACK" }
  | { type: "FEEDBACK_EMPTY" }
  | { type: "TOGGLE_COLLAPSE_VIEWED" }
  | { type: "CLEAR_FILTERS" }
  | { type: "TOGGLE_FOCUS" }
  | { type: "TOGGLE_SHEET"; sheet: Exclude<ReviewSheet, null> }
  | { type: "CLOSE_SHEET" }
  | { type: "DOCK" }
  | { type: "UNDOCK" }

export const codeReviewViewMachine = setup({
  types: {
    context: {} as CodeReviewViewContext,
    events: {} as CodeReviewViewEvent
  },
  actions: {
    closeSheet: assign(() => ({ sheet: null })),
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
    toggleCollapseViewed: assign(({ context }) => ({
      collapseViewed: !context.collapseViewed
    })),
    clearFilters: assign(() => ({
      query: "",
      kind: "all" as const,
      feedbackOnly: false
    })),
    toggleSheet: assign(({ context, event }) =>
      event.type === "TOGGLE_SHEET"
        ? { sheet: context.sheet === event.sheet ? null : event.sheet }
        : {}
    )
  }
}).createMachine({
  id: "codeReviewView",
  type: "parallel",
  context: {
    query: "",
    kind: "all",
    feedbackOnly: false,
    collapseViewed: true,
    sheet: null
  },
  on: {
    SET_QUERY: { actions: "setQuery" },
    SET_KIND: { actions: "setKind" },
    TOGGLE_FEEDBACK: { actions: "toggleFeedback" },
    FEEDBACK_EMPTY: { actions: "clearFeedback" },
    TOGGLE_COLLAPSE_VIEWED: { actions: "toggleCollapseViewed" },
    CLEAR_FILTERS: { actions: "clearFilters" },
    TOGGLE_SHEET: { actions: "toggleSheet" },
    CLOSE_SHEET: { actions: "closeSheet" }
  },
  states: {
    presentation: {
      initial: "browsing",
      states: {
        browsing: {
          on: { TOGGLE_FOCUS: "focused" }
        },
        focused: {
          entry: "closeSheet",
          on: { TOGGLE_FOCUS: "browsing" }
        }
      }
    },
    layout: {
      initial: "docked",
      states: {
        docked: {
          on: { UNDOCK: "sheets" }
        },
        sheets: {
          on: { DOCK: { target: "docked", actions: "closeSheet" } }
        }
      }
    }
  }
})
