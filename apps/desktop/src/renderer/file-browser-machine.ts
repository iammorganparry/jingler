import type {
  AssetFileEntry,
  AssetPayload,
  AssetTextPayload,
  AssetWriteResult
} from "@jingler/core"
import { Cause, Option, Runtime } from "effect"
import { assign, fromPromise, raise, setup } from "xstate"

export interface FileBrowserApi {
  readonly list: (sessionId: string) => Promise<ReadonlyArray<AssetFileEntry>>
  readonly read: (sessionId: string, path: string) => Promise<AssetPayload>
  readonly write: (
    sessionId: string,
    path: string,
    text: string,
    expectedRevision: string
  ) => Promise<AssetWriteResult>
}

export interface FileBrowserInput {
  readonly sessionId: string
}

export type FileBrowserPendingDiscard =
  | { readonly type: "open"; readonly path: string }
  | { readonly type: "reload" }

export type FileBrowserFailure =
  | { readonly type: "binary"; readonly path: string }
  | {
      readonly type: "too-large"
      readonly path: string
      readonly size: number
      readonly cap: number
    }
  | { readonly type: "unsupported"; readonly path: string }
  | {
      readonly type: "conflict"
      readonly path: string
      readonly expectedRevision: string
      readonly actualRevision: string
    }
  | { readonly type: "error"; readonly message: string }

export interface FileBrowserContext {
  readonly sessionId: string
  readonly entries: ReadonlyArray<AssetFileEntry>
  readonly treeError: string | null
  readonly selectedPath: string | null
  readonly payload: AssetPayload | null
  readonly draft: string | null
  readonly failure: FileBrowserFailure | null
  readonly pendingDiscard: FileBrowserPendingDiscard | null
  readonly viewMode: "preview" | "edit"
}

export type FileBrowserEvent =
  | { readonly type: "OPEN"; readonly path: string }
  | { readonly type: "EDIT"; readonly text: string }
  | { readonly type: "SAVE" }
  | { readonly type: "REFRESH_CONFLICT" }
  | { readonly type: "RELOAD" }
  | { readonly type: "REFRESH_TREE" }
  | { readonly type: "RETRY_TREE" }
  | { readonly type: "CONFIRM_DISCARD" }
  | { readonly type: "CANCEL_DISCARD" }
  | { readonly type: "START_EDIT" }
  | { readonly type: "SHOW_PREVIEW" }

const isTextPayload = (payload: AssetPayload): payload is AssetTextPayload =>
  "text" in payload

const isRichPreview = (payload: AssetPayload): boolean =>
  payload.kind === "markdown" || payload.kind === "csv"

const withOpenedPath = (
  entries: ReadonlyArray<AssetFileEntry>,
  path: string
): ReadonlyArray<AssetFileEntry> =>
  entries.some((entry) => entry.path === path)
    ? entries
    : [...entries, { path, status: "untracked" as const }].sort((a, b) =>
        a.path.localeCompare(b.path)
      )

const numberField = (value: object, key: string): number => {
  const field = key in value ? value[key as keyof typeof value] : undefined
  return typeof field === "number" ? field : 0
}

const stringField = (value: object, key: string, fallback: string): string => {
  const field = key in value ? value[key as keyof typeof value] : undefined
  return typeof field === "string" ? field : fallback
}

/** Unwrap Effect's renderer RPC rejection and keep its tagged asset details. */
export const fileBrowserFailure = (
  error: unknown,
  fallbackMessage: string
): FileBrowserFailure => {
  const failure = Runtime.isFiberFailure(error)
    ? Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId]))
    : error
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return { type: "error", message: fallbackMessage }
  }
  const path = stringField(failure, "path", "")
  switch (failure._tag) {
    case "AssetBinaryError":
      return { type: "binary", path }
    case "AssetTooLargeError":
      return {
        type: "too-large",
        path,
        size: numberField(failure, "size"),
        cap: numberField(failure, "cap")
      }
    case "AssetUnsupportedError":
      return { type: "unsupported", path }
    case "AssetWriteConflictError":
      return {
        type: "conflict",
        path,
        expectedRevision: stringField(failure, "expectedRevision", ""),
        actualRevision: stringField(failure, "actualRevision", "")
      }
    default:
      return { type: "error", message: fallbackMessage }
  }
}

/**
 * One deterministic file lifecycle per session. Tree loading is parallel with
 * document editing, while the document region makes dirty/saving/conflict modes
 * mutually exclusive and therefore impossible to render inconsistently.
 */
export const createFileBrowserMachine = (api: FileBrowserApi) =>
  setup({
    types: {
      context: {} as FileBrowserContext,
      events: {} as FileBrowserEvent,
      input: {} as FileBrowserInput
    },
    actors: {
      listFiles: fromPromise(
        ({ input }: { input: { readonly sessionId: string } }) => api.list(input.sessionId)
      ),
      readFile: fromPromise(
        ({ input }: { input: { readonly sessionId: string; readonly path: string } }) =>
          api.read(input.sessionId, input.path)
      ),
      writeFile: fromPromise(
        ({
          input
        }: {
          input: {
            readonly sessionId: string
            readonly path: string
            readonly text: string
            readonly expectedRevision: string
          }
        }) => api.write(input.sessionId, input.path, input.text, input.expectedRevision)
      )
    },
    actions: {
      selectPath: assign(({ event }) =>
        event.type === "OPEN"
          ? {
              selectedPath: event.path,
              payload: null,
              draft: null,
              failure: null,
              pendingDiscard: null,
              viewMode: "edit" as const
            }
          : {}
      ),
      queueDiscard: assign(({ event }) => {
        if (event.type === "OPEN") {
          return { pendingDiscard: { type: "open" as const, path: event.path } }
        }
        if (event.type === "RELOAD") {
          return { pendingDiscard: { type: "reload" as const } }
        }
        return {}
      }),
      applyPendingDiscard: assign(({ context }) => {
        const nextPath =
          context.pendingDiscard?.type === "open"
            ? context.pendingDiscard.path
            : context.selectedPath
        return {
          selectedPath: nextPath,
          payload: null,
          draft: null,
          failure: null,
          pendingDiscard: null,
          viewMode: "edit" as const
        }
      }),
      cancelDiscard: assign({ pendingDiscard: null }),
      editDraft: assign(({ event }) =>
        event.type === "EDIT" ? { draft: event.text, failure: null } : {}
      ),
      editConflictedDraft: assign(({ event }) =>
        event.type === "EDIT" ? { draft: event.text } : {}
      )
    },
    guards: {
      hasEditablePayload: ({ context }) =>
        context.payload !== null && isTextPayload(context.payload),
      editMatchesLoaded: ({ context, event }) =>
        event.type === "EDIT" &&
        context.payload !== null &&
        isTextPayload(context.payload) &&
        event.text === context.payload.text,
      hasUnsavedDraft: ({ context }) =>
        context.payload !== null &&
        isTextPayload(context.payload) &&
        context.draft !== null &&
        context.draft !== context.payload.text,
      hasEditsSinceSave: ({ context, event }) =>
        "output" in event &&
        typeof event.output === "object" &&
        event.output !== null &&
        "text" in event.output &&
        context.draft !== event.output.text,
      hasPendingDiscard: ({ context }) => context.pendingDiscard !== null
    }
  }).createMachine({
    id: "fileBrowser",
    type: "parallel",
    context: ({ input }) => ({
      sessionId: input.sessionId,
      entries: [],
      treeError: null,
      selectedPath: null,
      payload: null,
      draft: null,
      failure: null,
      pendingDiscard: null,
      viewMode: "edit"
    }),
    states: {
      tree: {
        initial: "loading",
        states: {
          loading: {
            invoke: {
              src: "listFiles",
              input: ({ context }) => ({ sessionId: context.sessionId }),
              onDone: {
                target: "ready",
                actions: assign({
                  entries: ({ event }) => event.output,
                  treeError: null
                })
              },
              onError: {
                target: "error",
                actions: assign({
                  treeError: () => "Couldn't refresh repository files."
                })
              }
            }
          },
          ready: {
            on: { REFRESH_TREE: "loading", RETRY_TREE: "loading" }
          },
          error: {
            on: { REFRESH_TREE: "loading", RETRY_TREE: "loading" }
          }
        }
      },
      document: {
        initial: "idle",
        on: {
          OPEN: [
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            {
              target: ".loading",
              reenter: true,
              actions: "selectPath"
            }
          ],
          RELOAD: [
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            { target: ".loading", reenter: true }
          ],
          CONFIRM_DISCARD: {
            guard: "hasPendingDiscard",
            target: ".loading",
            reenter: true,
            actions: "applyPendingDiscard"
          },
          CANCEL_DISCARD: { actions: "cancelDiscard" },
          START_EDIT: { actions: assign({ viewMode: "edit" }) },
          SHOW_PREVIEW: { actions: assign({ viewMode: "preview" }) }
        },
        states: {
          idle: {},
          loading: {
            invoke: {
              src: "readFile",
              input: ({ context }) => ({
                sessionId: context.sessionId,
                path: context.selectedPath ?? ""
              }),
              onDone: [
                {
                  guard: ({ event }) => isTextPayload(event.output),
                  target: "ready.clean",
                  actions: assign({
                    entries: ({ context, event }) =>
                      withOpenedPath(context.entries, event.output.path),
                    payload: ({ event }) => event.output,
                    draft: ({ event }) =>
                      isTextPayload(event.output) ? event.output.text : null,
                    failure: null,
                    pendingDiscard: null,
                    viewMode: ({ event }) =>
                      isRichPreview(event.output) ? "preview" : "edit"
                  })
                },
                {
                  target: "ready.readOnly",
                  actions: assign({
                    entries: ({ context, event }) =>
                      withOpenedPath(context.entries, event.output.path),
                    payload: ({ event }) => event.output,
                    draft: null,
                    failure: null,
                    pendingDiscard: null,
                    viewMode: "preview"
                  })
                }
              ],
              onError: [
                {
                  guard: ({ event }) =>
                    fileBrowserFailure(event.error, "Couldn't open file.").type === "binary",
                  target: "binary",
                  actions: assign({
                    failure: ({ event }) =>
                      fileBrowserFailure(event.error, "Couldn't open file.")
                  })
                },
                {
                  guard: ({ event }) =>
                    fileBrowserFailure(event.error, "Couldn't open file.").type === "too-large",
                  target: "tooLarge",
                  actions: assign({
                    failure: ({ event }) =>
                      fileBrowserFailure(event.error, "Couldn't open file.")
                  })
                },
                {
                  target: "loadError",
                  actions: assign({
                    failure: ({ event }) =>
                      fileBrowserFailure(event.error, "Couldn't open file.")
                  })
                }
              ]
            }
          },
          ready: {
            initial: "clean",
            states: {
              clean: {
                on: {
                  EDIT: {
                    guard: "hasEditablePayload",
                    target: "dirty",
                    actions: "editDraft"
                  }
                }
              },
              saved: {
                on: {
                  EDIT: {
                    guard: "hasEditablePayload",
                    target: "dirty",
                    actions: "editDraft"
                  }
                }
              },
              dirty: {
                on: {
                  EDIT: [
                    {
                      guard: "editMatchesLoaded",
                      target: "clean",
                      actions: "editDraft"
                    },
                    { actions: "editDraft" }
                  ],
                  SAVE: "#fileBrowser.document.saving"
                }
              },
              readOnly: {}
            }
          },
          saving: {
            on: {
              EDIT: { actions: "editDraft" }
            },
            invoke: {
              src: "writeFile",
              input: ({ context }) => ({
                sessionId: context.sessionId,
                path: context.selectedPath ?? "",
                text: context.draft ?? "",
                expectedRevision:
                  context.payload !== null && isTextPayload(context.payload)
                    ? context.payload.revision
                    : ""
              }),
              onDone: [
                {
                  guard: "hasEditsSinceSave",
                  target: "ready.dirty",
                  actions: [
                    assign({
                      payload: ({ event }) => event.output,
                      failure: null
                    }),
                    raise({ type: "REFRESH_TREE" })
                  ]
                },
                {
                  target: "ready.saved",
                  actions: [
                    assign({
                      payload: ({ event }) => event.output,
                      draft: ({ event }) => event.output.text,
                      failure: null
                    }),
                    raise({ type: "REFRESH_TREE" })
                  ]
                }
              ],
              onError: [
                {
                  guard: ({ event }) =>
                    fileBrowserFailure(event.error, "Couldn't save file.").type === "conflict",
                  target: "conflict",
                  actions: assign({
                    failure: ({ event }) =>
                      fileBrowserFailure(event.error, "Couldn't save file.")
                  })
                },
                {
                  target: "saveError",
                  actions: assign({
                    failure: ({ event }) =>
                      fileBrowserFailure(event.error, "Couldn't save file.")
                  })
                }
              ]
            }
          },
          conflict: {
            on: {
              EDIT: { actions: "editConflictedDraft" },
              REFRESH_CONFLICT: "refreshingConflict"
            }
          },
          refreshingConflict: {
            on: {
              EDIT: { actions: "editConflictedDraft" }
            },
            invoke: {
              src: "readFile",
              input: ({ context }) => ({
                sessionId: context.sessionId,
                path: context.selectedPath ?? ""
              }),
              onDone: [
                {
                  guard: ({ event }) => isTextPayload(event.output),
                  target: "ready.dirty",
                  actions: assign({
                    payload: ({ event }) => event.output,
                    failure: null
                  })
                },
                {
                  target: "conflict",
                  actions: assign({
                    failure: ({ context }) => context.failure
                  })
                }
              ],
              onError: {
                target: "conflict"
              }
            }
          },
          saveError: {
            on: {
              EDIT: { actions: "editDraft" },
              SAVE: "saving"
            }
          },
          binary: {},
          tooLarge: {},
          loadError: {}
        }
      }
    }
  })

export type FileBrowserMachine = ReturnType<typeof createFileBrowserMachine>
