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
  readonly diff: (sessionId: string) => Promise<string>
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
  | { readonly type: "close"; readonly path: string }

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
  readonly treeRefreshQueued: boolean
  readonly patch: string | null
  readonly patchError: string | null
  readonly openPaths: ReadonlyArray<string>
  readonly selectedPath: string | null
  readonly payload: AssetPayload | null
  readonly draft: string | null
  readonly failure: FileBrowserFailure | null
  readonly pendingDiscard: FileBrowserPendingDiscard | null
  readonly viewMode: "diff" | "edit"
}

export type FileBrowserEvent =
  | { readonly type: "VIEW_ACTIVATED" }
  | { readonly type: "OPEN"; readonly path: string }
  | { readonly type: "CLOSE"; readonly path: string }
  | { readonly type: "EDIT"; readonly text: string }
  | { readonly type: "SAVE" }
  | { readonly type: "REFRESH_CONFLICT" }
  | { readonly type: "RELOAD" }
  | { readonly type: "REFRESH_TREE" }
  | { readonly type: "RETRY_TREE" }
  | { readonly type: "CONFIRM_DISCARD" }
  | { readonly type: "CANCEL_DISCARD" }
  | { readonly type: "START_EDIT" }
  | { readonly type: "SHOW_DIFF" }

const isTextPayload = (payload: AssetPayload): payload is AssetTextPayload => "text" in payload

const diffFirst = (entries: ReadonlyArray<AssetFileEntry>, path: string): boolean => {
  const status = entries.find((entry) => entry.path === path)?.status
  return status === "modified" || status === "added" || status === "deleted" || status === "renamed"
}

const withOpenedPath = (
  entries: ReadonlyArray<AssetFileEntry>,
  path: string
): ReadonlyArray<AssetFileEntry> =>
  entries.some((entry) => entry.path === path)
    ? entries
    : [...entries, { path, status: "untracked" as const }].sort((a, b) =>
        a.path.localeCompare(b.path)
      )

const appendOpenPath = (paths: ReadonlyArray<string>, path: string): ReadonlyArray<string> =>
  paths.includes(path) ? paths : [...paths, path]

const closeFallback = (
  paths: ReadonlyArray<string>,
  path: string
): { readonly paths: ReadonlyArray<string>; readonly selectedPath: string | null } => {
  const index = paths.indexOf(path)
  if (index < 0) return { paths, selectedPath: null }
  const next = paths.filter((candidate) => candidate !== path)
  return {
    paths: next,
    selectedPath: next[Math.min(index, next.length - 1)] ?? null
  }
}

const numberField = (value: object, key: string): number => {
  const field = key in value ? value[key as keyof typeof value] : undefined
  return typeof field === "number" ? field : 0
}

const stringField = (value: object, key: string, fallback: string): string => {
  const field = key in value ? value[key as keyof typeof value] : undefined
  return typeof field === "string" ? field : fallback
}

/** Unwrap Effect's renderer RPC rejection and keep its tagged asset details. */
export const fileBrowserFailure = (error: unknown, fallbackMessage: string): FileBrowserFailure => {
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
    case "AssetWriteIoError":
      return {
        type: "error",
        message: stringField(failure, "message", fallbackMessage)
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
      listFiles: fromPromise(({ input }: { input: { readonly sessionId: string } }) =>
        api.list(input.sessionId)
      ),
      loadDiff: fromPromise(({ input }: { input: { readonly sessionId: string } }) =>
        api.diff(input.sessionId)
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
      selectPath: assign(({ context, event }) =>
        event.type === "OPEN"
          ? {
              openPaths: appendOpenPath(context.openPaths, event.path),
              selectedPath: event.path,
              payload: null,
              draft: null,
              failure: null,
              pendingDiscard: null,
              viewMode: diffFirst(context.entries, event.path)
                ? ("diff" as const)
                : ("edit" as const)
            }
          : {}
      ),
      queueDiscard: assign(({ event }) => {
        if (event.type === "OPEN") {
          return {
            pendingDiscard: { type: "open" as const, path: event.path }
          }
        }
        if (event.type === "RELOAD") {
          return { pendingDiscard: { type: "reload" as const } }
        }
        if (event.type === "CLOSE") {
          return {
            pendingDiscard: { type: "close" as const, path: event.path }
          }
        }
        return {}
      }),
      applyPendingDiscard: assign(({ context }) => {
        const closing =
          context.pendingDiscard?.type === "close"
            ? closeFallback(context.openPaths, context.pendingDiscard.path)
            : null
        const nextPath =
          context.pendingDiscard?.type === "close"
            ? (closing?.selectedPath ?? null)
            : context.pendingDiscard?.type === "open"
              ? context.pendingDiscard.path
              : context.selectedPath
        return {
          openPaths:
            context.pendingDiscard?.type === "open"
              ? appendOpenPath(context.openPaths, context.pendingDiscard.path)
              : (closing?.paths ?? context.openPaths),
          selectedPath: nextPath,
          payload: null,
          draft: null,
          failure: null,
          pendingDiscard: null,
          viewMode:
            nextPath !== null && diffFirst(context.entries, nextPath)
              ? ("diff" as const)
              : ("edit" as const)
        }
      }),
      closeInactivePath: assign(({ context, event }) =>
        event.type === "CLOSE"
          ? { openPaths: context.openPaths.filter((path) => path !== event.path) }
          : {}
      ),
      closeAndSelectFallback: assign(({ context, event }) => {
        if (event.type !== "CLOSE") return {}
        const next = closeFallback(context.openPaths, event.path)
        return {
          openPaths: next.paths,
          selectedPath: next.selectedPath,
          payload: null,
          draft: null,
          failure: null,
          pendingDiscard: null,
          viewMode:
            next.selectedPath !== null && diffFirst(context.entries, next.selectedPath)
              ? ("diff" as const)
              : ("edit" as const)
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
      hasPendingDiscard: ({ context }) => context.pendingDiscard !== null,
      opensSelectedPath: ({ context, event }) =>
        event.type === "OPEN" && event.path === context.selectedPath,
      closesInactivePath: ({ context, event }) =>
        event.type === "CLOSE" && event.path !== context.selectedPath,
      closeHasFallback: ({ context, event }) =>
        event.type === "CLOSE" &&
        closeFallback(context.openPaths, event.path).selectedPath !== null,
      pendingCloseHasFallback: ({ context }) =>
        context.pendingDiscard?.type === "close" &&
        closeFallback(context.openPaths, context.pendingDiscard.path).selectedPath !== null,
      pendingClose: ({ context }) => context.pendingDiscard?.type === "close"
    }
  }).createMachine({
    id: "fileBrowser",
    type: "parallel",
    context: ({ input }) => ({
      sessionId: input.sessionId,
      entries: [],
      treeError: null,
      treeRefreshQueued: false,
      patch: null,
      patchError: null,
      openPaths: [],
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
            on: {
              VIEW_ACTIVATED: {
                actions: assign({ treeRefreshQueued: true })
              },
              REFRESH_TREE: {
                target: "loading",
                reenter: true,
                actions: assign({ treeRefreshQueued: false })
              },
              RETRY_TREE: {
                target: "loading",
                reenter: true,
                actions: assign({ treeRefreshQueued: false })
              }
            },
            invoke: {
              src: "listFiles",
              input: ({ context }) => ({ sessionId: context.sessionId }),
              onDone: [
                {
                  guard: ({ context }) => context.treeRefreshQueued,
                  target: "loading",
                  reenter: true,
                  actions: assign({
                    entries: ({ event }) => event.output,
                    treeError: null,
                    treeRefreshQueued: false
                  })
                },
                {
                  target: "ready",
                  actions: assign({
                    entries: ({ event }) => event.output,
                    treeError: null
                  })
                }
              ],
              onError: [
                {
                  guard: ({ context }) => context.treeRefreshQueued,
                  target: "loading",
                  reenter: true,
                  actions: assign({ treeRefreshQueued: false })
                },
                {
                  target: "error",
                  actions: assign({
                    treeError: () => "Couldn't refresh repository files."
                  })
                }
              ]
            }
          },
          ready: {
            on: {
              VIEW_ACTIVATED: "loading",
              REFRESH_TREE: "loading",
              RETRY_TREE: "loading"
            }
          },
          error: {
            on: {
              VIEW_ACTIVATED: "loading",
              REFRESH_TREE: "loading",
              RETRY_TREE: "loading"
            }
          }
        }
      },
      changes: {
        initial: "loading",
        states: {
          loading: {
            invoke: {
              src: "loadDiff",
              input: ({ context }) => ({ sessionId: context.sessionId }),
              onDone: {
                target: "ready",
                actions: assign({
                  patch: ({ event }) => event.output,
                  patchError: null
                })
              },
              onError: {
                target: "error",
                actions: assign({
                  patchError: () => "Couldn't load file changes."
                })
              }
            }
          },
          ready: {},
          error: {}
        }
      },
      document: {
        initial: "idle",
        on: {
          OPEN: [
            { guard: "opensSelectedPath" },
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            {
              target: ".loading",
              reenter: true,
              actions: "selectPath"
            }
          ],
          CLOSE: [
            { guard: "closesInactivePath", actions: "closeInactivePath" },
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            {
              guard: "closeHasFallback",
              target: ".loading",
              reenter: true,
              actions: "closeAndSelectFallback"
            },
            {
              target: ".idle",
              actions: "closeAndSelectFallback"
            }
          ],
          RELOAD: [
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            { target: ".loading", reenter: true }
          ],
          CONFIRM_DISCARD: [
            {
              guard: "pendingCloseHasFallback",
              target: ".loading",
              reenter: true,
              actions: "applyPendingDiscard"
            },
            {
              guard: "pendingClose",
              target: ".idle",
              actions: "applyPendingDiscard"
            },
            {
              guard: "hasPendingDiscard",
              target: ".loading",
              reenter: true,
              actions: "applyPendingDiscard"
            }
          ],
          CANCEL_DISCARD: { actions: "cancelDiscard" },
          START_EDIT: { actions: assign({ viewMode: "edit" }) },
          SHOW_DIFF: { actions: assign({ viewMode: "diff" }) }
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
                    draft: ({ event }) => (isTextPayload(event.output) ? event.output.text : null),
                    failure: null,
                    pendingDiscard: null,
                    viewMode: ({ context }) => context.viewMode
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
                    viewMode: "edit"
                  })
                }
              ],
              onError: [
                {
                  guard: ({ event }) =>
                    fileBrowserFailure(event.error, "Couldn't open file.").type === "binary",
                  target: "binary",
                  actions: assign({
                    failure: ({ event }) => fileBrowserFailure(event.error, "Couldn't open file.")
                  })
                },
                {
                  guard: ({ event }) =>
                    fileBrowserFailure(event.error, "Couldn't open file.").type === "too-large",
                  target: "tooLarge",
                  actions: assign({
                    failure: ({ event }) => fileBrowserFailure(event.error, "Couldn't open file.")
                  })
                },
                {
                  target: "loadError",
                  actions: assign({
                    failure: ({ event }) => fileBrowserFailure(event.error, "Couldn't open file.")
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
                  EDIT: [
                    { guard: "editMatchesLoaded", actions: "editDraft" },
                    {
                      guard: "hasEditablePayload",
                      target: "dirty",
                      actions: "editDraft"
                    }
                  ]
                }
              },
              saved: {
                on: {
                  EDIT: [
                    { guard: "editMatchesLoaded", actions: "editDraft" },
                    {
                      guard: "hasEditablePayload",
                      target: "dirty",
                      actions: "editDraft"
                    }
                  ]
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
                    failure: ({ event }) => fileBrowserFailure(event.error, "Couldn't save file.")
                  })
                },
                {
                  target: "saveError",
                  actions: assign({
                    failure: ({ event }) => fileBrowserFailure(event.error, "Couldn't save file.")
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
