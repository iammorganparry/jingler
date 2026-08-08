import { useCallback, useMemo } from "react"
import { useSelector } from "@xstate/react"
import { createActor, type ActorRefFrom } from "xstate"
import type { AssetPayload } from "@jingler/core"
import {
  createFileBrowserMachine,
  type FileBrowserApi,
  type FileBrowserFailure,
  type FileBrowserMachine,
  type FileBrowserPendingDiscard
} from "./file-browser-machine.js"
import { rpc } from "./rpc-client.js"
import { listRepositoryFiles } from "./repository-file-list.js"

export type FileBrowserActor = ActorRefFrom<FileBrowserMachine>

const api: FileBrowserApi = {
  list: (sessionId, worktreePath) =>
    listRepositoryFiles(rpc, sessionId, worktreePath),
  diff: rpc.sessionsDiff,
  read: rpc.assetRead,
  write: rpc.assetWrite
}
const actors = new Map<string, FileBrowserActor>()

const getFileBrowserActor = (
  sessionId: string,
  worktreePath?: string
): FileBrowserActor => {
  const existing = actors.get(sessionId)
  if (existing !== undefined) return existing
  const actor = createActor(createFileBrowserMachine(api), {
    input: {
      sessionId,
      ...(worktreePath === undefined ? {} : { worktreePath })
    }
  })
  actor.start()
  actors.set(sessionId, actor)
  return actor
}

/** Open a path even while the Files tab is unmounted (transcript/quick-open route). */
export const openSessionFile = (sessionId: string, path: string): void => {
  getFileBrowserActor(sessionId).send({ type: "OPEN", path })
}

/** Persistent actors are session resources; collect one after permanent deletion. */
export const disposeFileBrowserActor = (sessionId: string): void => {
  const actor = actors.get(sessionId)
  if (actor === undefined) return
  actors.delete(sessionId)
  actor.stop()
}

export type FileBrowserStatus =
  | "idle"
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "read-only"
  | "conflict"
  | "binary"
  | "too-large"
  | "error"

export interface FileBrowserController {
  readonly entries: ReturnType<FileBrowserActor["getSnapshot"]>["context"]["entries"]
  readonly openPaths: ReadonlyArray<string>
  readonly treeLoading: boolean
  readonly treeError: string | null
  readonly patch: string | null
  readonly patchError: string | null
  readonly selectedPath: string | null
  readonly payload: AssetPayload | null
  readonly draft: string | null
  readonly failure: FileBrowserFailure | null
  readonly pendingDiscard: FileBrowserPendingDiscard | null
  readonly viewMode: "diff" | "edit"
  readonly status: FileBrowserStatus
  readonly dirty: boolean
  readonly followEnabled: boolean
  readonly agentTargetPath: string | null
  readonly activate: () => void
  readonly open: (path: string) => void
  readonly close: (path: string) => void
  readonly edit: (text: string) => void
  readonly save: () => void
  readonly refreshConflict: () => void
  readonly reload: () => void
  readonly refreshTree: () => void
  readonly confirmDiscard: () => void
  readonly cancelDiscard: () => void
  readonly startEdit: () => void
  readonly showDiff: () => void
  readonly enableFollow: () => void
  readonly disableFollow: () => void
  readonly followAgentTarget: (path: string, eventId: string, completed: boolean) => void
}

export function useFileBrowser(
  sessionId: string,
  worktreePath?: string
): FileBrowserController {
  const actor = useMemo(
    () => getFileBrowserActor(sessionId, worktreePath),
    [sessionId, worktreePath]
  )
  const snapshot = useSelector(actor, (state) => state)
  const activate = useCallback(() => actor.send({ type: "VIEW_ACTIVATED" }), [actor])
  const open = useCallback((path: string) => actor.send({ type: "OPEN", path }), [actor])
  const close = useCallback((path: string) => actor.send({ type: "CLOSE", path }), [actor])
  const edit = useCallback((text: string) => actor.send({ type: "EDIT", text }), [actor])
  const save = useCallback(() => actor.send({ type: "SAVE" }), [actor])
  const refreshConflict = useCallback(() => actor.send({ type: "REFRESH_CONFLICT" }), [actor])
  const reload = useCallback(() => actor.send({ type: "RELOAD" }), [actor])
  const refreshTree = useCallback(() => actor.send({ type: "REFRESH_TREE" }), [actor])
  const confirmDiscard = useCallback(() => actor.send({ type: "CONFIRM_DISCARD" }), [actor])
  const cancelDiscard = useCallback(() => actor.send({ type: "CANCEL_DISCARD" }), [actor])
  const startEdit = useCallback(() => actor.send({ type: "START_EDIT" }), [actor])
  const showDiff = useCallback(() => actor.send({ type: "SHOW_DIFF" }), [actor])
  const enableFollow = useCallback(() => actor.send({ type: "ENABLE_FOLLOW" }), [actor])
  const disableFollow = useCallback(() => actor.send({ type: "DISABLE_FOLLOW" }), [actor])
  const followAgentTarget = useCallback(
    (path: string, eventId: string, completed: boolean) =>
      actor.send({ type: "AGENT_TARGET", path, eventId, completed }),
    [actor]
  )

  const status: FileBrowserStatus = snapshot.matches({ document: "idle" })
    ? "idle"
    : snapshot.matches({ document: "loading" })
      ? "loading"
      : snapshot.matches({ document: { ready: "clean" } })
        ? "clean"
        : snapshot.matches({ document: { ready: "dirty" } })
          ? "dirty"
          : snapshot.matches({ document: { ready: "saved" } })
            ? "saved"
            : snapshot.matches({ document: { ready: "readOnly" } })
              ? "read-only"
              : snapshot.matches({ document: "saving" })
                ? "saving"
                : snapshot.matches({ document: "conflict" }) ||
                    snapshot.matches({ document: "refreshingConflict" })
                  ? "conflict"
                  : snapshot.matches({ document: "binary" })
                    ? "binary"
                    : snapshot.matches({ document: "tooLarge" })
                      ? "too-large"
                      : "error"
  const payload = snapshot.context.payload
  const dirty =
    snapshot.context.draft !== null &&
    payload !== null &&
    "text" in payload &&
    snapshot.context.draft !== payload.text

  return {
    entries: snapshot.context.entries,
    openPaths: snapshot.context.openPaths,
    treeLoading: snapshot.matches({ tree: "loading" }),
    treeError: snapshot.context.treeError,
    patch: snapshot.context.patch,
    patchError: snapshot.context.patchError,
    selectedPath: snapshot.context.selectedPath,
    payload,
    draft: snapshot.context.draft,
    failure: snapshot.context.failure,
    pendingDiscard: snapshot.context.pendingDiscard,
    viewMode: snapshot.context.viewMode,
    status,
    dirty,
    followEnabled: snapshot.matches({ follow: "enabled" }),
    agentTargetPath: snapshot.context.agentTargetPath,
    activate,
    open,
    close,
    edit,
    save,
    refreshConflict,
    reload,
    refreshTree,
    confirmDiscard,
    cancelDiscard,
    startEdit,
    showDiff,
    enableFollow,
    disableFollow,
    followAgentTarget
  }
}
