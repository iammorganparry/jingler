import type { PlanDocument } from "@jingler/core"
import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface PlanDocumentInput {
  readonly sessionId: string
  readonly load: () => Promise<PlanDocument | null>
  readonly save: (input: {
    readonly document: PlanDocument
    readonly source: string
  }) => Promise<PlanDocument>
  readonly subscribe?: (listener: (document: PlanDocument) => void) => () => void
}

export interface PlanDocumentContext extends PlanDocumentInput {
  readonly document: PlanDocument | null
  readonly draft: string
  readonly savingSource: string
  readonly remote: PlanDocument | null
  readonly error: string | null
}

export type PlanDocumentEvent =
  | { readonly type: "EDIT"; readonly source: string }
  | { readonly type: "SAVE_NOW" }
  | { readonly type: "RETRY" }
  | { readonly type: "REMOTE"; readonly document: PlanDocument }
  | { readonly type: "KEEP_LOCAL" }
  | { readonly type: "ACCEPT_REMOTE" }

const failure = (event: unknown): unknown =>
  typeof event === "object" && event !== null && "error" in event
    ? (event as { readonly error: unknown }).error
    : event

const latestFrom = (event: unknown): PlanDocument | null => {
  const error = failure(event)
  if (typeof error !== "object" || error === null || !("latest" in error)) return null
  const latest = (error as { readonly latest?: unknown }).latest
  return typeof latest === "object" && latest !== null ? latest as PlanDocument : null
}

const messageFrom = (event: unknown): string => {
  const error = failure(event)
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

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
    saveDocument: fromPromise(
      ({
        input
      }: {
        input: {
          readonly document: PlanDocument
          readonly source: string
          readonly save: PlanDocumentInput["save"]
        }
      }) => input.save({ document: input.document, source: input.source })
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
    hasDocument: ({ context }) => context.document !== null,
    draftChangedWhileSaving: ({ context }) => context.draft !== context.savingSource,
    remoteAdvances: ({ context, event }) =>
      event.type === "REMOTE" &&
      (context.document === null || event.document.revision > context.document.revision),
    isConflict: ({ event }) => latestFrom(event) !== null
  },
  actions: {
    edit: assign(({ event }) => event.type === "EDIT" ? { draft: event.source, error: null } : {}),
    beginSave: assign(({ context }) => ({ savingSource: context.draft, error: null })),
    loaded: assign((_, params: { readonly document: PlanDocument | null }) => {
      const { document } = params
      return {
        document,
        draft: document?.source ?? "",
        savingSource: "",
        remote: null,
        error: null
      }
    }),
    saved: assign((_, params: { readonly document: PlanDocument }) => ({
      document: params.document,
      draft: params.document.source,
      savingSource: "",
      remote: null,
      error: null
    })),
    savedWithNewDraft: assign(({ context }, params: { readonly document: PlanDocument }) => ({
      document: params.document,
      draft: context.draft,
      savingSource: "",
      remote: null,
      error: null
    })),
    applyRemote: assign(({ event }) =>
      event.type === "REMOTE"
        ? {
            document: event.document,
            draft: event.document.source,
            savingSource: "",
            remote: null,
            error: null
          }
        : {}
    ),
    rememberRemote: assign(({ event }) =>
      event.type === "REMOTE" ? { remote: event.document } : {}
    ),
    rememberConflict: assign(({ event }) => ({
      remote: latestFrom(event),
      savingSource: "",
      error: messageFrom(event)
    })),
    rememberError: assign(({ event }) => ({
      savingSource: "",
      error: messageFrom(event)
    })),
    keepLocal: assign(({ context }) => ({
      document: context.remote ?? context.document,
      remote: null,
      error: null
    })),
    acceptRemote: assign(({ context }) =>
      context.remote === null
        ? {}
        : {
            document: context.remote,
            draft: context.remote.source,
            savingSource: "",
            remote: null,
            error: null
          }
    )
  }
}).createMachine({
  id: "planDocument",
  initial: "loading",
  context: ({ input }) => ({
    ...input,
    document: null,
    draft: "",
    savingSource: "",
    remote: null,
    error: null
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
        EDIT: { target: "editing", actions: "edit" },
        REMOTE: { guard: "remoteAdvances", actions: "applyRemote" }
      }
    },
    editing: {
      after: {
        350: { target: "saving", guard: "hasDocument", actions: "beginSave" }
      },
      on: {
        EDIT: { target: "editing", reenter: true, actions: "edit" },
        SAVE_NOW: { target: "saving", guard: "hasDocument", actions: "beginSave" },
        REMOTE: {
          guard: "remoteAdvances",
          target: "conflict",
          actions: "rememberRemote"
        }
      }
    },
    saving: {
      invoke: {
        src: "saveDocument",
        input: ({ context }) => ({
          document: context.document!,
          source: context.savingSource,
          save: context.save
        }),
        onDone: [
          {
            guard: "draftChangedWhileSaving",
            target: "editing",
            actions: {
              type: "savedWithNewDraft",
              params: ({ event }) => ({ document: event.output })
            }
          },
          {
            target: "clean",
            actions: {
              type: "saved",
              params: ({ event }) => ({ document: event.output })
            }
          }
        ],
        onError: [
          { guard: "isConflict", target: "conflict", actions: "rememberConflict" },
          { target: "error", actions: "rememberError" }
        ]
      },
      on: {
        EDIT: { actions: "edit" },
        REMOTE: {
          guard: "remoteAdvances",
          target: "conflict",
          actions: "rememberRemote"
        }
      }
    },
    conflict: {
      on: {
        EDIT: { actions: "edit" },
        KEEP_LOCAL: { target: "editing", actions: "keepLocal" },
        ACCEPT_REMOTE: { target: "clean", actions: "acceptRemote" },
        REMOTE: { guard: "remoteAdvances", actions: "rememberRemote" }
      }
    },
    error: {
      on: {
        RETRY: [
          { guard: "hasDocument", target: "saving", actions: "beginSave" },
          { target: "loading" }
        ],
        EDIT: { target: "editing", actions: "edit" },
        REMOTE: { guard: "remoteAdvances", target: "clean", actions: "applyRemote" }
      }
    }
  }
})
