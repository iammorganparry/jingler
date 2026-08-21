import type { ExplanationDocument } from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface ExplanationDocumentInput {
  readonly sessionId: string
  readonly load: () => Promise<ExplanationDocument | null>
  readonly subscribe?: (listener: (document: ExplanationDocument | null) => void) => () => void
}

export interface ExplanationDocumentContext extends ExplanationDocumentInput {
  readonly document: ExplanationDocument | null
  readonly error: string | null
}

export type ExplanationDocumentEvent =
  | { readonly type: "RETRY" }
  | { readonly type: "REMOTE"; readonly document: ExplanationDocument | null }

const messageFrom = (event: unknown): string => {
  const error = typeof event === "object" && event !== null && "error" in event
    ? (event as { readonly error: unknown }).error
    : event
  return error instanceof Error ? error.message : String(error)
}

export const explanationDocumentMachine = setup({
  types: {
    input: {} as ExplanationDocumentInput,
    context: {} as ExplanationDocumentContext,
    events: {} as ExplanationDocumentEvent
  },
  actors: {
    loadDocument: fromPromise(
      ({ input }: { input: Pick<ExplanationDocumentContext, "load"> }) => input.load()
    ),
    watchDocument: fromCallback<ExplanationDocumentEvent, Pick<ExplanationDocumentContext, "subscribe">>(
      ({ sendBack, input }) => input.subscribe?.((document) => sendBack({ type: "REMOTE", document })) ?? (() => {})
    )
  },
  guards: {
    remoteAdvances: ({ context, event }) =>
      event.type === "REMOTE" && (
        event.document === null
          ? context.document !== null
          : context.document === null ||
            event.document.id !== context.document.id ||
            event.document.revision > context.document.revision
      )
  },
  actions: {
    loaded: assign((_, params: { readonly document: ExplanationDocument | null }) => ({
      document: params.document,
      error: null
    })),
    applyRemote: assign(({ event }) =>
      event.type === "REMOTE" ? { document: event.document, error: null } : {}
    ),
    rememberError: assign(({ event }) => ({ error: messageFrom(event) }))
  }
}).createMachine({
  id: "explanationDocument",
  initial: "loading",
  context: ({ input }) => ({ ...input, document: null, error: null }),
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
          actions: { type: "loaded", params: ({ event }) => ({ document: event.output }) }
        },
        onError: { target: "error", actions: "rememberError" }
      }
    },
    clean: {
      on: { REMOTE: { guard: "remoteAdvances", actions: "applyRemote" } }
    },
    error: {
      on: {
        RETRY: { target: "loading" },
        REMOTE: { guard: "remoteAdvances", target: "clean", actions: "applyRemote" }
      }
    }
  }
})
