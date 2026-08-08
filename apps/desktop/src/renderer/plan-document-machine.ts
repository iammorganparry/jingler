import type { PlanDocument } from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface PlanDocumentInput {
  readonly sessionId: string
  readonly load: () => Promise<PlanDocument | null>
  readonly subscribe?: (listener: (document: PlanDocument) => void) => () => void
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
  | { readonly type: "REMOTE"; readonly document: PlanDocument }

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
    remoteAdvances: ({ context, event }) =>
      event.type === "REMOTE" &&
      (context.document === null || event.document.revision > context.document.revision)
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
            draft: JSON.stringify(event.document.plan),
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
