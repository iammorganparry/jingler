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

export type FileBrowserActor = ActorRefFrom<FileBrowserMachine>

const api: FileBrowserApi = {
  list: rpc.assetList,
  read: rpc.assetRead,
  write: rpc.assetWrite
}
const actors = new Map<string, FileBrowserActor>()

const getFileBrowserActor = (sessionId: string): FileBrowserActor => {
  const existing = actors.get(sessionId)
  if (existing !== undefined) return existing
  const actor = createActor(createFileBrowserMachine(api), { input: { sessionId } })
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
  readonly treeLoading: boolean
  readonly treeError: string | null
  readonly selectedPath: string | null
  readonly payload: AssetPayload | null
  readonly draft: string | null
  readonly failure: FileBrowserFailure | null
  readonly pendingDiscard: FileBrowserPendingDiscard | null
  readonly viewMode: "preview" | "edit"
  readonly status: FileBrowserStatus
  readonly dirty: boolean
  readonly open: (path: string) => void
  readonly edit: (text: string) => void
  readonly save: () => void
  readonly reload: () => void
  readonly refreshTree: () => void
  readonly confirmDiscard: () => void
  readonly cancelDiscard: () => void
  readonly startEdit: () => void
  readonly showPreview: () => void
}

export function useFileBrowser(sessionId: string): FileBrowserController {
  const actor = useMemo(() => getFileBrowserActor(sessionId), [sessionId])
  const snapshot = useSelector(actor, (state) => state)
  const open = useCallback((path: string) => actor.send({ type: "OPEN", path }), [actor])
  const edit = useCallback((text: string) => actor.send({ type: "EDIT", text }), [actor])
  const save = useCallback(() => actor.send({ type: "SAVE" }), [actor])
  const reload = useCallback(() => actor.send({ type: "RELOAD" }), [actor])
  const refreshTree = useCallback(() => actor.send({ type: "REFRESH_TREE" }), [actor])
  const confirmDiscard = useCallback(() => actor.send({ type: "CONFIRM_DISCARD" }), [actor])
  const cancelDiscard = useCallback(() => actor.send({ type: "CANCEL_DISCARD" }), [actor])
  const startEdit = useCallback(() => actor.send({ type: "START_EDIT" }), [actor])
  const showPreview = useCallback(() => actor.send({ type: "SHOW_PREVIEW" }), [actor])

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
                : snapshot.matches({ document: "conflict" })
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
    treeLoading: snapshot.matches({ tree: "loading" }),
    treeError: snapshot.context.treeError,
    selectedPath: snapshot.context.selectedPath,
    payload,
    draft: snapshot.context.draft,
    failure: snapshot.context.failure,
    pendingDiscard: snapshot.context.pendingDiscard,
    viewMode: snapshot.context.viewMode,
    status,
    dirty,
    open,
    edit,
    save,
    reload,
    refreshTree,
    confirmDiscard,
    cancelDiscard,
    startEdit,
    showPreview
  }
}
