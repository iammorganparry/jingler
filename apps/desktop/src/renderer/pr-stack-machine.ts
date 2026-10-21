import { assign, setup } from "xstate"

/** Selected layer of a session's PR stack plus merge-stack progress. Layers are ordered base-up. */
export interface PrStackContext {
  /** PR numbers, bottom layer first. */
  readonly numbers: ReadonlyArray<number>
  readonly selected: number | null
  /** Layers merged so far out of the stack size; set once a merge-stack run starts. */
  readonly merged: number
  readonly mergeError: string | null
  /** Merged layer whose upper layers are being restacked (squash/rebase merges only). */
  readonly restackAfter: number | null
}

export type PrStackEvent =
  | { type: "STACK_CHANGED"; numbers: ReadonlyArray<number>; current?: number }
  | { type: "SELECT"; number: number }
  | { type: "NEXT" }
  | { type: "PREV" }
  | { type: "MERGE_STACK"; merged?: number }
  | { type: "RESUME" }
  | { type: "LAYER_MERGED"; restackAfter?: number }
  | { type: "RESTACK_DONE" }
  | { type: "MERGE_FAILED"; message: string }

const step = (context: PrStackContext, delta: 1 | -1): number | null => {
  const index = context.selected === null ? -1 : context.numbers.indexOf(context.selected)
  return context.numbers[index + delta] ?? context.selected
}

const allMerged = ({ context }: { context: PrStackContext }): boolean =>
  context.numbers.length > 0 && context.merged >= context.numbers.length

export const prStackMachine = setup({
  types: {
    context: {} as PrStackContext,
    events: {} as PrStackEvent,
    input: {} as { numbers?: ReadonlyArray<number>; current?: number } | undefined
  },
  guards: { allMerged },
  actions: {
    setStack: assign(({ context, event }) => {
      if (event.type !== "STACK_CHANGED") return {}
      const kept = context.selected !== null && event.numbers.includes(context.selected)
      return {
        numbers: event.numbers,
        selected: kept ? context.selected : (event.current ?? event.numbers.at(-1) ?? null)
      }
    }),
    select: assign(({ context, event }) =>
      event.type === "SELECT" && context.numbers.includes(event.number) ? { selected: event.number } : {}
    ),
    next: assign(({ context }) => ({ selected: step(context, 1) })),
    prev: assign(({ context }) => ({ selected: step(context, -1) })),
    startMerge: assign(({ event }) => ({ merged: event.type === "MERGE_STACK" ? (event.merged ?? 0) : 0, mergeError: null })),
    resume: assign({ mergeError: null }),
    layerMerged: assign(({ context, event }) => ({
      merged: context.merged + 1,
      restackAfter: event.type === "LAYER_MERGED" ? (event.restackAfter ?? null) : null
    })),
    restackDone: assign({ restackAfter: null }),
    mergeFailed: assign({ mergeError: ({ event }) => (event.type === "MERGE_FAILED" ? event.message : null) })
  }
}).createMachine({
  id: "prStack",
  context: ({ input }) => ({
    numbers: input?.numbers ?? [],
    selected: input?.current ?? input?.numbers?.at(-1) ?? null,
    merged: 0,
    mergeError: null,
    restackAfter: null
  }),
  on: {
    STACK_CHANGED: { actions: "setStack" },
    SELECT: { actions: "select" },
    NEXT: { actions: "next" },
    PREV: { actions: "prev" }
  },
  initial: "idle",
  states: {
    idle: { on: { MERGE_STACK: { target: "merging", actions: "startMerge" } } },
    merging: {
      always: { guard: "allMerged", target: "merged" },
      on: {
        LAYER_MERGED: [
          { guard: ({ event }) => event.restackAfter !== undefined, actions: "layerMerged", target: "restacking" },
          { actions: "layerMerged", target: "merging", reenter: true }
        ],
        MERGE_FAILED: { target: "failed", actions: "mergeFailed" }
      }
    },
    restacking: {
      on: {
        RESTACK_DONE: { target: "merging", actions: "restackDone" },
        MERGE_FAILED: { target: "failed", actions: "mergeFailed" }
      }
    },
    // Resume continues from the failed layer: `merged` is kept.
    failed: { on: { RESUME: { target: "merging", actions: "resume" } } },
    merged: {}
  }
})
