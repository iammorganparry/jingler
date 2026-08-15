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

/**
 * The last patch counted, and its answer.
 *
 * The registry re-derives a session's diff totals from the same unchanged patch
 * string many times over (a patch only moves on `PATCH_UPDATED`, but the
 * derivation used to be driven by the actor's subscription), and a repeat call is
 * by far the common case. The identity check in front of the scan makes those
 * repeats free.
 */
let lastPatch: string | null = null
let lastCounts: LiveDiffStat = { added: 0, removed: 0, files: 0 }

/**
 * Count added/removed lines and changed files in a unified diff, ignoring the
 * `+++`/`---` headers. A file is a `diff --git` header — one per changed file
 * in git's output, renames and binaries included.
 *
 * Scans in place rather than over `patch.split("\n")`. A worktree diff runs to
 * megabytes, and splitting it allocated an array of every line in it — on a hot
 * path, that array was one of the largest repeat allocations the renderer made.
 * The result is identical; only the garbage is gone.
 */
export const diffCounts = (patch: string): LiveDiffStat => {
  if (patch === lastPatch) return lastCounts

  let added = 0
  let removed = 0
  let files = 0
  let i = 0
  while (i < patch.length) {
    const newline = patch.indexOf("\n", i)
    // `charCodeAt` over `startsWith` for the common case: every line is tested,
    // and only the three that matter pay for a prefix comparison.
    const first = patch.charCodeAt(i)
    if (first === 43 /* + */) {
      if (!patch.startsWith("+++", i)) added++
    } else if (first === 45 /* - */) {
      if (!patch.startsWith("---", i)) removed++
    } else if (first === 100 /* d */) {
      if (patch.startsWith("diff --git", i)) files++
    }
    if (newline === -1) break
    i = newline + 1
  }

  lastPatch = patch
  lastCounts = { added, removed, files }
  return lastCounts
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
