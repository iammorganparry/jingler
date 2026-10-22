import { assign, setup } from "xstate"

export type ReviewFindingSeverity = "issue" | "nit"

/** One finding proposed by a review agent. Nothing reaches GitHub until the operator submits. */
export interface ReviewFindingDraft {
  readonly id: string
  readonly severity: ReviewFindingSeverity
  readonly path: string
  readonly line: number
  readonly body: string
}

export type ReviewRunStatus = "idle" | "running" | "done" | "failed"

export interface ReviewDrawerContext {
  /** Progress of the read-only review agent that produces `drafts`. */
  readonly run: ReviewRunStatus
  readonly error: string | null
  readonly drafts: ReadonlyArray<ReviewFindingDraft>
  /** Drafts moved into the review composer as pending inline comments. */
  readonly added: ReadonlyArray<string>
  readonly dismissed: ReadonlyArray<string>
}

type ReviewDrawerEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "TOGGLE" }
  | { type: "PROMOTE" }
  | { type: "SET_DRAFTS"; drafts: ReadonlyArray<ReviewFindingDraft> }
  | { type: "RUN"; status: ReviewRunStatus; error?: string }
  | { type: "ADD"; id: string }
  | { type: "ADD_ALL" }
  | { type: "DISMISS"; id: string }
  | { type: "SUBMITTED" }

export const undecidedDrafts = (context: ReviewDrawerContext) =>
  context.drafts.filter((d) => !context.added.includes(d.id) && !context.dismissed.includes(d.id))

export const addedDrafts = (context: ReviewDrawerContext) =>
  context.drafts.filter((d) => context.added.includes(d.id))

/** The composer body: the operator's text followed by each pending inline comment. */
export function composeReviewBody(body: string, pending: ReadonlyArray<ReviewFindingDraft>): string {
  const lines = pending.map((d) => `- **${d.severity === "issue" ? "Issue" : "Nit"}** \`${d.path}:${d.line}\` — ${d.body}`)
  return [body, ...lines].filter(Boolean).join("\n\n")
}

/** Decisions survive PR switches (the view remounts per PR), keyed by `repo#number`. */
const savedDecisions = new Map<string, Pick<ReviewDrawerContext, "added" | "dismissed">>()
export const saveDecisions = (key: string, context: ReviewDrawerContext) =>
  savedDecisions.set(key, { added: context.added, dismissed: context.dismissed })
export const loadDecisions = (key: string) => savedDecisions.get(key) ?? { added: [], dismissed: [] }

const union = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => [...new Set([...a, ...b])]

/**
 * Review drawer on the sidebar PR view. Drafts and decisions live in context, so they survive
 * close/reopen while the same PR stays selected.
 */
export const reviewDrawerMachine = setup({
  types: {
    context: {} as ReviewDrawerContext,
    input: {} as Partial<Pick<ReviewDrawerContext, "added" | "dismissed">>,
    events: {} as ReviewDrawerEvent
  },
  guards: {
    hasUndecided: ({ context }) => undecidedDrafts(context).length > 0,
    noneUndecided: ({ context }) => undecidedDrafts(context).length === 0
  }
}).createMachine({
  id: "review-drawer",
  context: ({ input }) => ({ drafts: [], added: input?.added ?? [], dismissed: input?.dismissed ?? [], run: "idle", error: null }),
  initial: "closed",
  on: {
    SET_DRAFTS: { actions: assign({ drafts: ({ event }) => event.drafts }) },
    RUN: { actions: assign({ run: ({ event }) => event.status, error: ({ event }) => event.error ?? null }) },
    ADD: { actions: assign({ added: ({ context, event }) => union(context.added, [event.id]) }) },
    ADD_ALL: { actions: assign({ added: ({ context }) => union(context.added, undecidedDrafts(context).map((d) => d.id)) }) },
    DISMISS: { actions: assign({ dismissed: ({ context, event }) => union(context.dismissed, [event.id]) }) },
    SUBMITTED: { actions: assign({ dismissed: ({ context }) => union(context.dismissed, context.added), added: [] }) }
  },
  states: {
    closed: { on: { OPEN: "open", TOGGLE: "open" } },
    open: {
      always: { guard: "hasUndecided", target: "reviewing" },
      on: { CLOSE: "closed", TOGGLE: "closed", PROMOTE: "promoted" }
    },
    reviewing: {
      always: { guard: "noneUndecided", target: "open" },
      on: { CLOSE: "closed", TOGGLE: "closed", PROMOTE: "promoted" }
    },
    promoted: { on: { CLOSE: "closed", TOGGLE: "closed" } }
  }
})
