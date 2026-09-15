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

let diffs: Record<string, LiveDiffStat> = {}
const listeners = new Set<() => void>()

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
export const clearSessionDiff = (id: string): void =>
  setSessionDiff(id, { added: 0, removed: 0, files: 0 })

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
