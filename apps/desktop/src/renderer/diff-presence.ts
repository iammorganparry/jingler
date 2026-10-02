/**
 * A tiny cross-component store of each session's *live* worktree diff totals
 * (added / removed line counts). The conversation registry writes to it from the
 * actor subscription (so it stays live even while the pane is unmounted); the
 * main tab bar reads it to show `+N −N` on the Changes tab — the persisted
 * `Session.diff` is never updated during a run, so this fills that gap. Mirrors
 * `session-status.ts`.
 */
import { useSyncExternalStore } from "react"
import type { DiffStat } from "@jingler/core"

/** Live totals plus the changed-file count — what the composer's dirty badge shows. */
export interface LiveDiffStat extends DiffStat {
  readonly files: number
}

export type SessionFileDiffs = Readonly<Record<string, Readonly<Record<string, DiffStat>>>>

let diffs: Record<string, LiveDiffStat> = {}
let fileDiffs: SessionFileDiffs = {}
const listeners = new Set<() => void>()

export const fileDiffStat = (patch: string): DiffStat => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

export const setSessionFileDiff = (sessionId: string, path: string, stat: DiffStat): void => {
  const session = fileDiffs[sessionId] ?? {}
  const previous = session[path]
  if (previous?.added === stat.added && previous.removed === stat.removed) return
  const nextSession = { ...session }
  if (stat.added === 0 && stat.removed === 0) delete nextSession[path]
  else nextSession[path] = stat
  const next = { ...fileDiffs }
  if (Object.keys(nextSession).length === 0) delete next[sessionId]
  else next[sessionId] = nextSession
  fileDiffs = next
  for (const listener of listeners) listener()
}

/** Set (or clear, when empty) a session's live diff totals; notifies subscribers. */
export const setSessionDiff = (id: string, stat: LiveDiffStat): void => {
  const prev = diffs[id]
  if (stat.added === 0 && stat.removed === 0 && stat.files === 0) {
    if (prev === undefined) return
    const next = { ...diffs }
    delete next[id]
    diffs = next
  } else {
    if (
      prev &&
      prev.added === stat.added &&
      prev.removed === stat.removed &&
      prev.files === stat.files
    ) return
    diffs = { ...diffs, [id]: stat }
  }
  for (const listener of listeners) listener()
}

/** Clear a session's diff (on dispose). */
export const clearSessionDiff = (id: string): void => {
  setSessionDiff(id, { added: 0, removed: 0, files: 0 })
  if (fileDiffs[id] === undefined) return
  const next = { ...fileDiffs }
  delete next[id]
  fileDiffs = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live worktree diff totals, keyed by session id. Absent → no changes. */
export const useSessionDiffs = (): Record<string, LiveDiffStat> =>
  useSyncExternalStore(
    subscribe,
    () => diffs,
    () => diffs
  )

export const useSessionFileDiffs = (): SessionFileDiffs =>
  useSyncExternalStore(
    subscribe,
    () => fileDiffs,
    () => fileDiffs
  )
