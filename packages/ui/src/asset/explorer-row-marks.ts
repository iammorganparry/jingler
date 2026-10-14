import type { AssetFileEntry } from "@jingler/core"

export interface ExplorerRowMark {
  /** Git status letter for a file; null for clean files and folders. */
  readonly letter: string | null
  /** Folder only: some descendant has a git change or an agent edit. */
  readonly changedDescendant: boolean
  readonly agentEdited: boolean
  /** The agent is writing this file right now (pulses until the run ends). */
  readonly editingNow: boolean
}

const STATUS_LETTER: Record<AssetFileEntry["status"], string | null> = {
  clean: null,
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U"
}

const EMPTY: ExplorerRowMark = {
  letter: null,
  changedDescendant: false,
  agentEdited: false,
  editingNow: false
}

const ancestorsOf = (path: string): string[] => {
  const segments = path.split("/").slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
}

/** Marks keyed by repo-relative path with no trailing slash (folders use their own path). */
export const explorerRowMarks = (
  entries: readonly AssetFileEntry[],
  agentEditedPaths: Iterable<string>,
  editingPath: string | null
): ReadonlyMap<string, ExplorerRowMark> => {
  const marks = new Map<string, ExplorerRowMark>()
  const update = (path: string, patch: Partial<ExplorerRowMark>): void => {
    marks.set(path, { ...(marks.get(path) ?? EMPTY), ...patch })
  }
  const markFile = (path: string, patch: Partial<ExplorerRowMark>): void => {
    update(path, patch)
    for (const folder of ancestorsOf(path)) update(folder, { changedDescendant: true })
  }
  for (const entry of entries) {
    if (entry.status !== "clean") {
      markFile(entry.path, { letter: STATUS_LETTER[entry.status] })
    }
  }
  const edited = new Set(editingPath === null ? agentEditedPaths : [...agentEditedPaths, editingPath])
  for (const path of edited) markFile(path, { agentEdited: true, editingNow: path === editingPath })
  return marks
}

/** Look up a Pierre item path (folders arrive with a trailing slash). */
export const explorerMarkFor = (
  marks: ReadonlyMap<string, ExplorerRowMark>,
  itemPath: string
): ExplorerRowMark | undefined => marks.get(itemPath.replace(/\/$/, ""))
