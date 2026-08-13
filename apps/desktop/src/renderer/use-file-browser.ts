import { useCallback, useEffect, useMemo } from "react"
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
import { lruKeysToEvict } from "./registry-eviction.js"

export type FileBrowserActor = ActorRefFrom<FileBrowserMachine>

const api: FileBrowserApi = {
  list: (sessionId, worktreePath) =>
    listRepositoryFiles(rpc, sessionId, worktreePath),
  diff: rpc.sessionsDiff,
  read: rpc.assetRead,
  write: rpc.assetWrite
}
const actors = new Map<string, FileBrowserActor>()

/**
 * How many mounted `useFileBrowser` hooks reference each session's actor.
 *
 * A ref-count, not a flag, because one session's browser is mounted from several
 * places at once (the conversation pane, the Files tab, the session's chat-tab
 * strip). An actor is "mounted" — and never evictable — while any of them holds
 * it; it drops to zero only once the whole session is off-screen.
 */
const mounts = new Map<string, number>()

/**
 * How many actors stay resident. Six matches the conversation registry's cap
 * (`MAX_LIVE_ACTORS`): the same deepest session grid plus a couple of recent
 * sessions, bounding the retained worktree diff strings and open-file payloads
 * rather than letting one accumulate per session the operator ever opened.
 */
export const MAX_FILE_BROWSER_ACTORS = 6

/**
 * Whether dropping this actor would lose unrecoverable work: a dirty or mid-save
 * draft (the edit exists nowhere else), or a surface still mounted (evicting
 * would blank a browser the operator is looking at and immediately rebuild it).
 * A clean, unmounted actor re-creates on demand from disk, so it is safe to drop.
 */
export const isFileBrowserActorPinned = (
  actor: FileBrowserActor,
  mounted: boolean
): boolean => {
  if (mounted) return true
  const snapshot = actor.getSnapshot()
  if (snapshot.matches({ document: "saving" })) return true
  const { draft, payload } = snapshot.context
  if (draft === null) return false
  // A draft that no longer differs from the file is not work worth pinning for;
  // one with no text payload to compare against is unsaved by default.
  return payload !== null && "text" in payload ? draft !== payload.text : true
}

/** Drop the least-recently-used unpinned actors once residency exceeds the cap. */
const evictFileBrowserActors = (keep: string): void => {
  // `actors` insertion order IS recency order — `getFileBrowserActor` re-inserts
  // on every hit — so iterating it yields the LRU-first list the policy wants.
  const candidates = [...actors.entries()].map(([sessionId, actor]) => ({
    key: sessionId,
    pinned: isFileBrowserActorPinned(actor, (mounts.get(sessionId) ?? 0) > 0)
  }))
  for (const key of lruKeysToEvict(candidates, { keep, max: MAX_FILE_BROWSER_ACTORS })) {
    const actor = actors.get(key)
    if (actor === undefined) continue
    actors.delete(key)
    actor.stop()
  }
}

const getFileBrowserActor = (
  sessionId: string,
  worktreePath?: string
): FileBrowserActor => {
  const existing = actors.get(sessionId)
  if (existing !== undefined) {
    // Re-insert to move this key to the most-recently-used end (see
    // `evictFileBrowserActors`): `Map` keeps insertion order, and `set` on an
    // existing key leaves it in place, so without the delete the policy would
    // read creation order and drop the session just switched back to.
    actors.delete(sessionId)
    actors.set(sessionId, existing)
    return existing
  }
  const actor = createActor(createFileBrowserMachine(api), {
    input: {
      sessionId,
      ...(worktreePath === undefined ? {} : { worktreePath })
    }
  })
  actor.start()
  actors.set(sessionId, actor)
  evictFileBrowserActors(sessionId)
  return actor
}

/** Ref-count a mounted hook onto its session's actor; released on unmount. */
const retainFileBrowserActor = (sessionId: string): void => {
  mounts.set(sessionId, (mounts.get(sessionId) ?? 0) + 1)
}

const releaseFileBrowserActor = (sessionId: string): void => {
  const next = (mounts.get(sessionId) ?? 0) - 1
  if (next <= 0) mounts.delete(sessionId)
  else mounts.set(sessionId, next)
}

/** Open a path even while the Files tab is unmounted (transcript/quick-open route). */
export const openSessionFile = (sessionId: string, path: string): void => {
  getFileBrowserActor(sessionId).send({ type: "OPEN", path })
}

/** Persistent actors are session resources; collect one after permanent deletion. */
export const disposeFileBrowserActor = (sessionId: string): void => {
  mounts.delete(sessionId)
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
  readonly agentTargetEventId: string | null
  readonly agentTargetPreview: string | null
  readonly agentTargetCompleted: boolean
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
  readonly followAgentTarget: (
    path: string,
    eventId: string,
    preview: string | null,
    completed: boolean
  ) => void
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
  // Pin this session's actor against eviction for as long as a browser is
  // mounted on it, across however many components mount one at once.
  useEffect(() => {
    retainFileBrowserActor(sessionId)
    return () => releaseFileBrowserActor(sessionId)
  }, [sessionId])
  useEffect(() => {
    if (worktreePath === undefined) return
    actor.send({ type: "SYNC_WORKTREE", worktreePath })
  }, [actor, worktreePath])
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
    (path: string, eventId: string, preview: string | null, completed: boolean) =>
      actor.send({ type: "AGENT_TARGET", path, eventId, preview, completed }),
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
    agentTargetEventId: snapshot.context.agentTargetEventId,
    agentTargetPreview: snapshot.context.agentTargetPreview,
    agentTargetCompleted: snapshot.context.agentTargetCompleted,
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
