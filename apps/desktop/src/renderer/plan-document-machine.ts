import { type Plan, type PlanDocument, planDocumentToPlan } from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface PlanDocumentInput {
  readonly sessionId: string
  readonly load: () => Promise<PlanDocument | null>
  readonly subscribe?: (listener: (document: PlanDocument | null) => void) => () => void
}

export interface PlanDocumentContext extends PlanDocumentInput {
  readonly document: PlanDocument | null
  readonly draft: string
  readonly error: string | null
  readonly revisionTarget: { readonly baseRevision: number; readonly stageId: string | null } | null
}

export type PlanDocumentEvent =
  | { readonly type: "RETRY" }
  | { readonly type: "REVISION_STARTED"; readonly stageId: string | null }
  | { readonly type: "REMOTE"; readonly document: PlanDocument | null }

/**
 * Approval is revision-sensitive, so the transcript card and canonical document
 * must describe the same projection before the renderer enables it. PlanUpdated
 * and Plan.watch use separate streams; either may arrive first.
 */
export const matchesCanonicalPlan = (
  document: PlanDocument | null,
  visiblePlan: Plan | null
): boolean => {
  if (document === null || visiblePlan === null) return false
  const canonical = planDocumentToPlan(document)
  return (
    canonical.id === visiblePlan.id &&
    canonical.summary === visiblePlan.summary &&
    canonical.raw === visiblePlan.raw &&
    canonical.status === visiblePlan.status
  )
}

const messageFrom = (event: unknown): string => {
  const error =
    typeof event === "object" && event !== null && "error" in event
      ? (event as { readonly error: unknown }).error
      : event
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

/**
 * Loads the canonical plan document and keeps it in step with `Plan.watch`
 * broadcasts (remote-wins). The operator no longer edits the plan text, so there
 * is no local draft, no debounced autosave and no compare-and-swap conflict
 * state here — the plan is rendered read-only and its only mutation (commenting)
 * flows through its own path. `draft` mirrors the canonical source purely so
 * existing read-only consumers keep a stable field to render.
 */
export const planDocumentMachine = setup({
  types: {
    input: {} as PlanDocumentInput,
    context: {} as PlanDocumentContext,
    events: {} as PlanDocumentEvent
  },
  actors: {
    loadDocument: fromPromise(
      ({ input }: { input: Pick<PlanDocumentContext, "load"> }) => input.load()
    ),
    watchDocument: fromCallback<
      PlanDocumentEvent,
      Pick<PlanDocumentContext, "subscribe">
    >(({ sendBack, input }) => {
      if (input.subscribe === undefined) return () => {}
      return input.subscribe((document) => sendBack({ type: "REMOTE", document }))
    })
  },
  guards: {
    // The watch stream re-reads the single canonical plan file, so a differing
    // id means the file now holds a DIFFERENT plan (a fresh replacement resets
    // to revision 1) and a null document means the plan was discarded. Neither
    // is ordered against the held revision — only same-id updates are.
    remoteAdvances: ({ context, event }) => {
      if (event.type !== "REMOTE") return false
      if (event.document === null) return context.document !== null
      return (
        context.document === null ||
        event.document.id !== context.document.id ||
        event.document.revision > context.document.revision
      )
    }
  },
  actions: {
    loaded: assign((_, params: { readonly document: PlanDocument | null }) => {
      const { document } = params
      return {
        document,
        draft: document ? JSON.stringify(document.plan) : "",
        error: null
      }
    }),
    applyRemote: assign(({ event }) =>
      event.type === "REMOTE"
        ? {
            document: event.document,
            draft: event.document === null ? "" : JSON.stringify(event.document.plan),
            error: null
          }
        : {}
    ),
    beginRevision: assign(({ context, event }) =>
      event.type === "REVISION_STARTED"
        ? {
            revisionTarget: {
              baseRevision: context.document?.revision ?? 0,
              stageId: event.stageId
            }
          }
        : {}
    ),
    clearRevision: assign(() => ({ revisionTarget: null })),
    rememberError: assign(({ event }) => ({ error: messageFrom(event) }))
  }
}).createMachine({
  id: "planDocument",
  initial: "loading",
  context: ({ input }) => ({
    ...input,
    document: null,
    draft: "",
    error: null,
    revisionTarget: null
  }),
  invoke: {
    src: "watchDocument",
    input: ({ context }) => ({ subscribe: context.subscribe })
  },
  states: {
    loading: {
      invoke: {
        src: "loadDocument",
        input: ({ context }) => ({ load: context.load }),
        onDone: {
          target: "clean",
          actions: {
            type: "loaded",
            params: ({ event }) => ({ document: event.output })
          }
        },
        onError: { target: "error", actions: "rememberError" }
      }
    },
    clean: {
      on: {
        REVISION_STARTED: { target: "revising", actions: "beginRevision" },
        REMOTE: { guard: "remoteAdvances", actions: "applyRemote" }
      }
    },
    revising: {
      after: {
        90000: { target: "clean", actions: "clearRevision" }
      },
      on: {
        REVISION_STARTED: { actions: "beginRevision" },
        REMOTE: {
          guard: "remoteAdvances",
          target: "clean",
          actions: ["applyRemote", "clearRevision"]
        }
      }
    },
    error: {
      on: {
        RETRY: { target: "loading" },
        REMOTE: { guard: "remoteAdvances", target: "clean", actions: "applyRemote" }
      }
    }
  }
})
