import type {
  AssetFileEntry,
  AssetPayload,
  AssetTextPayload,
  AssetWriteResult
} from "@jingler/core"
import type { SessionFileDiff } from "@jingler/contracts"
import { Cause, Option, Runtime } from "effect"
import { assign, fromPromise, raise, setup } from "xstate"
import { resolveAgentFollowPath } from "./file-diff-context.js"

export interface FileBrowserApi {
  readonly list: (
    sessionId: string,
    worktreePath?: string
  ) => Promise<ReadonlyArray<AssetFileEntry>>
  readonly diff: (sessionId: string, path: string) => Promise<SessionFileDiff>
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
  readonly worktreePath?: string
  /** Path-owned split editors skip duplicate repository scans and diff loads. */
  readonly documentOnly?: boolean
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
  readonly worktreePath?: string
  readonly documentOnly: boolean
  readonly entries: ReadonlyArray<AssetFileEntry>
  readonly treeError: string | null
  readonly treeRefreshQueued: boolean
  readonly patch: string | null
  readonly patchTooLarge: Extract<SessionFileDiff, { kind: "too-large" }> | null
  readonly patchError: string | null
  readonly diffPath: string | null
  readonly diffCache: Readonly<Record<string, SessionFileDiff>>
  readonly openPaths: ReadonlyArray<string>
  readonly selectedPath: string | null
  readonly payload: AssetPayload | null
  readonly draft: string | null
  readonly failure: FileBrowserFailure | null
  readonly pendingDiscard: FileBrowserPendingDiscard | null
  readonly viewMode: "diff" | "edit"
  readonly agentTargetPath: string | null
  readonly agentTargetEventId: string | null
  readonly agentTargetPreview: string | null
  readonly agentTargetCompleted: boolean
  readonly pendingAgentTarget: {
    readonly path: string
    readonly eventId: string
    readonly preview: string | null
    readonly completed: boolean
    readonly refreshRequested: boolean
  } | null
}

export type FileBrowserEvent =
  | { readonly type: "VIEW_ACTIVATED" }
  | { readonly type: "SYNC_WORKTREE"; readonly worktreePath: string }
  | { readonly type: "OPEN"; readonly path: string }
  /** List a path among the open files without showing it here (a pane of its own shows it). */
  | { readonly type: "TRACK"; readonly path: string }
  | { readonly type: "CLOSE"; readonly path: string }
  | { readonly type: "EDIT"; readonly text: string }
  | { readonly type: "SAVE" }
  | { readonly type: "REFRESH_CONFLICT" }
  | { readonly type: "RELOAD" }
  | { readonly type: "REFRESH_TREE" }
  | { readonly type: "REFRESH_DIFF" }
  | { readonly type: "RETRY_TREE" }
  | { readonly type: "CONFIRM_DISCARD" }
  | { readonly type: "CANCEL_DISCARD" }
  | { readonly type: "START_EDIT" }
  | { readonly type: "SHOW_DIFF" }
  | { readonly type: "ENABLE_FOLLOW" }
  | { readonly type: "DISABLE_FOLLOW" }
  | {
      readonly type: "AGENT_TARGET"
      readonly path: string
      readonly eventId: string
      readonly preview?: string | null
      readonly completed: boolean
    }
  | { readonly type: "DIFF_LOADED"; readonly patch: string }
  | { readonly type: "LOAD_DIFF"; readonly path: string }
  | { readonly type: "TRY_PENDING_AGENT_TARGET" }

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

const refreshedEntries = (
  current: ReadonlyArray<AssetFileEntry>,
  next: ReadonlyArray<AssetFileEntry>
): ReadonlyArray<AssetFileEntry> =>
  next.length === 0 && current.length > 0 ? current : next

const appendOpenPath = (paths: ReadonlyArray<string>, path: string): ReadonlyArray<string> =>
  paths.includes(path) ? paths : [...paths, path]

const MAX_CACHED_FILE_DIFFS = 4
const cacheFileDiff = (
  cache: Readonly<Record<string, SessionFileDiff>>,
  path: string,
  result: SessionFileDiff
): Readonly<Record<string, SessionFileDiff>> =>
  Object.fromEntries(
    [...Object.entries(cache).filter(([candidate]) => candidate !== path), [path, result]]
      .slice(-MAX_CACHED_FILE_DIFFS)
  )

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
      listFiles: fromPromise(
        ({
          input
        }: {
          input: { readonly sessionId: string; readonly worktreePath?: string }
        }) => api.list(input.sessionId, input.worktreePath)
      ),
      loadDiff: fromPromise(
        ({ input }: { input: { readonly sessionId: string; readonly path: string } }) =>
          api.diff(input.sessionId, input.path)
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
      prepareDiff: assign(({ context, event }) => {
        const path = event.type === "LOAD_DIFF" ? event.path : context.selectedPath
        if (path === null) return {}
        return {
          diffPath: path,
          patch: null,
          patchTooLarge: null,
          patchError: null,
          ...(event.type === "REFRESH_DIFF" || event.type === "VIEW_ACTIVATED"
            ? { diffCache: {} }
            : {})
        }
      }),
      activateCachedDiff: assign(({ context, event }) => {
        const path = event.type === "LOAD_DIFF" ? event.path : context.selectedPath
        const result = path === null ? undefined : context.diffCache[path]
        if (path === null || result === undefined) return {}
        return {
          diffPath: path,
          patch: result.kind === "patch" ? result.patch : null,
          patchTooLarge: result.kind === "too-large" ? result : null,
          patchError: null,
          diffCache: cacheFileDiff(context.diffCache, path, result)
        }
      }),
      syncWorktree: assign(({ context, event }) =>
        event.type === "SYNC_WORKTREE"
          ? {
              worktreePath: event.worktreePath,
              patch: null,
              patchTooLarge: null,
              patchError: null,
              diffPath: context.selectedPath,
              diffCache: {}
            }
          : {}
      ),
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
      rememberAgentTarget: assign(({ event }) =>
        event.type === "AGENT_TARGET"
          ? {
              agentTargetPath: event.path,
              agentTargetEventId: event.eventId,
              agentTargetPreview: event.preview ?? null,
              agentTargetCompleted: event.completed,
              pendingAgentTarget: {
                path: event.path,
                eventId: event.eventId,
                preview: event.preview ?? null,
                completed: event.completed,
                refreshRequested: event.completed
              }
            }
          : {}
      ),
      resolveAgentTargetPath: assign(({ context, event }) => {
        if (event.type !== "DIFF_LOADED") return {}
        const currentPath = context.pendingAgentTarget?.path
        const resolvedPath =
          currentPath === undefined
            ? null
            : resolveAgentFollowPath(event.patch, currentPath)
        const moved =
          currentPath !== undefined && resolvedPath !== null && resolvedPath !== currentPath
        return {
          ...(resolvedPath === null ? {} : { agentTargetPath: resolvedPath }),
          ...(moved
            ? {
                openPaths: Array.from(
                  new Set(
                    context.openPaths.map((path) =>
                      path === currentPath ? resolvedPath : path
                    )
                  )
                ),
                selectedPath:
                  context.selectedPath === currentPath
                    ? resolvedPath
                    : context.selectedPath
              }
            : {}),
          pendingAgentTarget:
            context.pendingAgentTarget === null || resolvedPath === null
              ? context.pendingAgentTarget
              : { ...context.pendingAgentTarget, path: resolvedPath }
        }
      }),
      selectPendingAgentTarget: assign(({ context }) => {
        const path = context.pendingAgentTarget?.path
        if (path === undefined) return {}
        return {
          openPaths: appendOpenPath(context.openPaths, path),
          selectedPath: path,
          payload: null,
          draft: null,
          failure: null,
          pendingDiscard: null,
          pendingAgentTarget: null,
          viewMode:
            context.pendingAgentTarget?.completed === true ? ("diff" as const) : ("edit" as const)
        }
      }),
      clearPendingAgentTarget: assign({ pendingAgentTarget: null }),
      markAgentRefreshRequested: assign(({ context }) => ({
        pendingAgentTarget:
          context.pendingAgentTarget === null
            ? null
            : { ...context.pendingAgentTarget, refreshRequested: true }
      })),
      clearFollowTarget: assign({
        agentTargetPath: null,
        agentTargetEventId: null,
        agentTargetPreview: null,
        agentTargetCompleted: false,
        pendingAgentTarget: null
      }),
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
      loadNextDiff: raise(({ context, event }) => {
        const pending = context.pendingDiscard
        const closing =
          event.type === "CLOSE"
            ? event.path
            : pending?.type === "close"
              ? pending.path
              : null
        return {
          type: "LOAD_DIFF" as const,
          path:
            closing !== null
              ? (closeFallback(context.openPaths, closing).selectedPath ?? "")
              : pending?.type === "open"
                ? pending.path
                : (context.selectedPath ?? "")
        }
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
      trackPath: assign(({ context, event }) =>
        event.type === "TRACK" ? { openPaths: appendOpenPath(context.openPaths, event.path) } : {}
      ),
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
      documentOnly: ({ context }) => context.documentOnly,
      hasDiffPath: ({ context }) => context.selectedPath !== null,
      hasCachedDiff: ({ context, event }) => {
        const path = event.type === "LOAD_DIFF" ? event.path : context.selectedPath
        return path !== null && Object.hasOwn(context.diffCache, path)
      },
      worktreeChanged: ({ context, event }) =>
        event.type === "SYNC_WORKTREE" &&
        context.worktreePath !== event.worktreePath,
      selectedWorktreeChanged: ({ context, event }) =>
        event.type === "SYNC_WORKTREE" &&
        !context.documentOnly &&
        context.selectedPath !== null &&
        context.worktreePath !== event.worktreePath,
      treeEmpty: ({ context }) => context.entries.length === 0,
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
      pendingClose: ({ context }) => context.pendingDiscard?.type === "close",
      pendingAgentTargetIsSelected: ({ context }) =>
        context.pendingAgentTarget !== null &&
        !context.pendingAgentTarget.completed &&
        context.pendingAgentTarget.path === context.selectedPath,
      pendingAgentTargetIsSelectedAndCompleted: ({ context }) =>
        context.pendingAgentTarget?.completed === true &&
        context.pendingAgentTarget.path === context.selectedPath &&
        context.entries.some((entry) => entry.path === context.pendingAgentTarget?.path),
      pendingAgentTargetCanOpen: ({ context }) =>
        context.pendingAgentTarget !== null &&
        context.entries.some((entry) => entry.path === context.pendingAgentTarget?.path) &&
        !(
          context.payload !== null &&
          isTextPayload(context.payload) &&
          context.draft !== null &&
          context.draft !== context.payload.text
        ),
      pendingAgentTargetNeedsRefresh: ({ context }) =>
        context.pendingAgentTarget?.completed === true &&
        !context.pendingAgentTarget.refreshRequested,
      completedAgentTarget: ({ event }) =>
        event.type === "AGENT_TARGET" && event.completed
    }
  }).createMachine({
    id: "fileBrowser",
    type: "parallel",
    context: ({ input }) => ({
      sessionId: input.sessionId,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      documentOnly: input.documentOnly ?? false,
      entries: [],
      treeError: null,
      treeRefreshQueued: false,
      patch: null,
      patchTooLarge: null,
      patchError: null,
      diffPath: null,
      diffCache: {},
      openPaths: [],
      selectedPath: null,
      payload: null,
      draft: null,
      failure: null,
      pendingDiscard: null,
      viewMode: "edit",
      agentTargetPath: null,
      agentTargetEventId: null,
      agentTargetPreview: null,
      agentTargetCompleted: false,
      pendingAgentTarget: null
    }),
    on: {
      TRACK: { actions: "trackPath" }
    },
    states: {
      follow: {
        initial: "disabled",
        states: {
          disabled: {
            on: { ENABLE_FOLLOW: "enabled" }
          },
          enabled: {
            on: {
              DISABLE_FOLLOW: { target: "disabled", actions: "clearFollowTarget" },
              AGENT_TARGET: [
                {
                  guard: "completedAgentTarget",
                  actions: [
                    "rememberAgentTarget",
                    raise({ type: "REFRESH_TREE" }),
                    raise({ type: "REFRESH_DIFF" }),
                  ]
                },
                {
                  actions: ["rememberAgentTarget", raise({ type: "TRY_PENDING_AGENT_TARGET" })]
                }
              ],
              DIFF_LOADED: {
                actions: ["resolveAgentTargetPath", raise({ type: "TRY_PENDING_AGENT_TARGET" })]
              }
            }
          }
        }
      },
      tree: {
        initial: "loading",
        states: {
          loading: {
            always: { guard: "documentOnly", target: "ready" },
            on: {
              SYNC_WORKTREE: {
                guard: "worktreeChanged",
                target: "loading",
                reenter: true,
                actions: "syncWorktree"
              },
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
              input: ({ context }) => ({
                sessionId: context.sessionId,
                ...(context.worktreePath === undefined
                  ? {}
                  : { worktreePath: context.worktreePath })
              }),
              onDone: [
                {
                  // A view activation can overlap the actor's speculative first
                  // scan. Retry only when that scan found nothing: a non-empty
                  // inventory is already useful and walking the whole repository
                  // again would add cost without changing the visible result.
                  guard: ({ context, event }) =>
                    context.treeRefreshQueued && event.output.length === 0,
                  target: "loading",
                  reenter: true,
                  actions: [
                    assign({
                      entries: ({ context, event }) =>
                        refreshedEntries(context.entries, event.output),
                      treeError: null,
                      treeRefreshQueued: false
                    }),
                    raise({ type: "TRY_PENDING_AGENT_TARGET" })
                  ]
                },
                {
                  target: "ready",
                  actions: [
                    assign({
                      entries: ({ context, event }) =>
                        refreshedEntries(context.entries, event.output),
                      treeError: null,
                      treeRefreshQueued: false
                    }),
                    raise({ type: "TRY_PENDING_AGENT_TARGET" })
                  ]
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
              SYNC_WORKTREE: [
                {
                  guard: "worktreeChanged",
                  target: "loading",
                  actions: "syncWorktree"
                },
                { guard: "treeEmpty", target: "loading" }
              ],
              VIEW_ACTIVATED: "loading",
              REFRESH_TREE: "loading",
              RETRY_TREE: "loading"
            }
          },
          error: {
            on: {
              SYNC_WORKTREE: [
                {
                  guard: "worktreeChanged",
                  target: "loading",
                  actions: "syncWorktree"
                },
                { guard: "treeEmpty", target: "loading" }
              ],
              VIEW_ACTIVATED: "loading",
              REFRESH_TREE: "loading",
              RETRY_TREE: "loading"
            }
          }
        }
      },
      changes: {
        initial: "ready",
        states: {
          loading: {
            on: {
              LOAD_DIFF: [
                { guard: "hasCachedDiff", target: "ready", actions: "activateCachedDiff" },
                { target: "loading", reenter: true, actions: "prepareDiff" }
              ],
              REFRESH_DIFF: { guard: "hasDiffPath", target: "loading", reenter: true, actions: "prepareDiff" },
              VIEW_ACTIVATED: { guard: "hasDiffPath", target: "loading", reenter: true, actions: "prepareDiff" },
              SYNC_WORKTREE: {
                guard: "selectedWorktreeChanged",
                target: "loading",
                reenter: true
              }
            },
            invoke: {
              src: "loadDiff",
              input: ({ context }) => ({
                sessionId: context.sessionId,
                path: context.diffPath ?? ""
              }),
              onDone: {
                target: "ready",
                actions: [
                  assign(({ context, event }) => ({
                    patch: event.output.kind === "patch" ? event.output.patch : null,
                    patchTooLarge: event.output.kind === "too-large" ? event.output : null,
                    patchError: null,
                    diffCache:
                      context.diffPath === null
                        ? context.diffCache
                        : cacheFileDiff(context.diffCache, context.diffPath, event.output)
                  })),
                  raise(({ event }) => ({
                    type: "DIFF_LOADED" as const,
                    patch: event.output.kind === "patch" ? event.output.patch : ""
                  }))
                ]
              },
              onError: {
                target: "error",
                actions: assign({
                  patchError: () => "Couldn't load file changes."
                })
              }
            }
          },
          ready: {
            on: {
              LOAD_DIFF: [
                { guard: "documentOnly" },
                { guard: "hasCachedDiff", actions: "activateCachedDiff" },
                { target: "loading", actions: "prepareDiff" }
              ],
              REFRESH_DIFF: { guard: "hasDiffPath", target: "loading", actions: "prepareDiff" },
              VIEW_ACTIVATED: { guard: "hasDiffPath", target: "loading", actions: "prepareDiff" },
              SYNC_WORKTREE: {
                guard: "selectedWorktreeChanged",
                target: "loading"
              }
            }
          },
          error: {
            on: {
              LOAD_DIFF: { target: "loading", actions: "prepareDiff" },
              REFRESH_DIFF: { guard: "hasDiffPath", target: "loading", actions: "prepareDiff" },
              VIEW_ACTIVATED: { guard: "hasDiffPath", target: "loading", actions: "prepareDiff" },
              SYNC_WORKTREE: {
                guard: "selectedWorktreeChanged",
                target: "loading"
              }
            }
          }
        }
      },
      document: {
        initial: "idle",
        on: {
          OPEN: [
            {
              guard: "opensSelectedPath",
              actions: raise({ type: "DISABLE_FOLLOW" })
            },
            {
              guard: "hasUnsavedDraft",
              actions: ["queueDiscard", raise({ type: "DISABLE_FOLLOW" })]
            },
            {
              target: ".loading",
              reenter: true,
              actions: [
                "selectPath",
                raise({ type: "DISABLE_FOLLOW" }),
                raise(({ event }) => ({
                  type: "LOAD_DIFF" as const,
                  path: event.type === "OPEN" ? event.path : ""
                }))
              ]
            }
          ],
          CLOSE: [
            { guard: "closesInactivePath", actions: "closeInactivePath" },
            { guard: "hasUnsavedDraft", actions: "queueDiscard" },
            {
              guard: "closeHasFallback",
              target: ".loading",
              reenter: true,
              actions: ["loadNextDiff", "closeAndSelectFallback"]
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
              actions: ["loadNextDiff", "applyPendingDiscard"]
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
              actions: ["loadNextDiff", "applyPendingDiscard"]
            }
          ],
          CANCEL_DISCARD: { actions: "cancelDiscard" },
          START_EDIT: { actions: assign({ viewMode: "edit" }) },
          SHOW_DIFF: { actions: assign({ viewMode: "diff" }) }
        },
        states: {
          idle: {
            on: {
              TRY_PENDING_AGENT_TARGET: [
                {
                  guard: "pendingAgentTargetIsSelectedAndCompleted",
                  target: "loading",
                  actions: "selectPendingAgentTarget"
                },
                {
                  guard: "pendingAgentTargetIsSelected",
                  actions: "clearPendingAgentTarget"
                },
                {
                  guard: "pendingAgentTargetCanOpen",
                  target: "loading",
                  actions: "selectPendingAgentTarget"
                },
                {
                  guard: "pendingAgentTargetNeedsRefresh",
                  actions: ["markAgentRefreshRequested", raise({ type: "REFRESH_TREE" })]
                }
              ]
            }
          },
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
                  actions: [
                    assign({
                      entries: ({ context, event }) =>
                        withOpenedPath(context.entries, event.output.path),
                      payload: ({ event }) => event.output,
                      draft: ({ event }) => (isTextPayload(event.output) ? event.output.text : null),
                      failure: null,
                      pendingDiscard: null,
                      viewMode: ({ context }) => context.viewMode
                    }),
                    raise({ type: "TRY_PENDING_AGENT_TARGET" })
                  ]
                },
                {
                  target: "ready.readOnly",
                  actions: [
                    assign({
                      entries: ({ context, event }) =>
                        withOpenedPath(context.entries, event.output.path),
                      payload: ({ event }) => event.output,
                      draft: null,
                      failure: null,
                      pendingDiscard: null,
                      viewMode: "edit"
                    }),
                    raise({ type: "TRY_PENDING_AGENT_TARGET" })
                  ]
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
                  TRY_PENDING_AGENT_TARGET: [
                    {
                      guard: "pendingAgentTargetIsSelectedAndCompleted",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetIsSelected",
                      actions: "clearPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetCanOpen",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetNeedsRefresh",
                      actions: ["markAgentRefreshRequested", raise({ type: "REFRESH_TREE" })]
                    }
                  ],
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
                  TRY_PENDING_AGENT_TARGET: [
                    {
                      guard: "pendingAgentTargetIsSelectedAndCompleted",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetIsSelected",
                      actions: "clearPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetCanOpen",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetNeedsRefresh",
                      actions: ["markAgentRefreshRequested", raise({ type: "REFRESH_TREE" })]
                    }
                  ],
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
              readOnly: {
                on: {
                  TRY_PENDING_AGENT_TARGET: [
                    {
                      guard: "pendingAgentTargetIsSelectedAndCompleted",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetIsSelected",
                      actions: "clearPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetCanOpen",
                      target: "#fileBrowser.document.loading",
                      actions: "selectPendingAgentTarget"
                    },
                    {
                      guard: "pendingAgentTargetNeedsRefresh",
                      actions: ["markAgentRefreshRequested", raise({ type: "REFRESH_TREE" })]
                    }
                  ]
                }
              }
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
                    raise({ type: "REFRESH_TREE" }),
                    raise({ type: "REFRESH_DIFF" })
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
                    raise({ type: "REFRESH_TREE" }),
                    raise({ type: "REFRESH_DIFF" })
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
