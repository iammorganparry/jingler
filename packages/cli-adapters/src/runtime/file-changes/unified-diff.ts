export interface UnifiedDiffStats {
  readonly added: number
  readonly removed: number
  readonly preview: string | null
  readonly binary: boolean
  readonly noNewlineAtEnd: boolean
}

export interface GitDiffStat {
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

/** Parse the count fields from `git diff --numstat -z` without touching path data. */
export const gitDiffStat = (raw: string): GitDiffStat => {
  const firstTab = raw.indexOf("\t")
  const secondTab = raw.indexOf("\t", firstTab + 1)
  if (firstTab <= 0 || secondTab <= firstTab + 1) {
    throw new Error("invalid git numstat output")
  }

  const added = raw.slice(0, firstTab)
  const removed = raw.slice(firstTab + 1, secondTab)
  if (added === "-" || removed === "-") {
    if (added !== "-" || removed !== "-") throw new Error("invalid binary git numstat output")
    return { added: 0, removed: 0, binary: true }
  }

  const parsedAdded = Number(added)
  const parsedRemoved = Number(removed)
  if (!Number.isSafeInteger(parsedAdded) || parsedAdded < 0 || !Number.isSafeInteger(parsedRemoved) || parsedRemoved < 0) {
    throw new Error("invalid git numstat counts")
  }
  return { added: parsedAdded, removed: parsedRemoved, binary: false }
}

interface ParseState {
  readonly preview: Array<string>
  readonly added: number
  readonly removed: number
  readonly inHunk: boolean
  readonly noNewlineAtEnd: boolean
}

const parseLine = (state: ParseState, line: string): ParseState => {
  if (line.startsWith("@@")) return { ...state, inHunk: true }
  if (line.startsWith("diff --git ")) return { ...state, inHunk: false }
  if (line === "\\ No newline at end of file") return { ...state, noNewlineAtEnd: true }
  if (!state.inHunk) return state
  const marker = line[0]
  if (marker !== "+" && marker !== "-" && marker !== " ") return state
  state.preview.push(line)
  return {
    ...state,
    added: state.added + (marker === "+" ? 1 : 0),
    removed: state.removed + (marker === "-" ? 1 : 0)
  }
}

/** Parse only unified hunk bodies; headers never count as source changes. */
export const unifiedDiffStats = (diff: string, maxPreviewLines = 120): UnifiedDiffStats => {
  const binary = diff.includes("GIT binary patch") || diff.includes("Binary files ")
  const parsed = diff.split("\n").reduce(parseLine, {
    preview: [],
    added: 0,
    removed: 0,
    inHunk: false,
    noNewlineAtEnd: false
  })
  const shown = parsed.preview.slice(0, maxPreviewLines)
  const hidden = parsed.preview.length - shown.length
  if (hidden > 0) shown.push(`…${hidden} more diff line(s)`)
  return {
    added: parsed.added,
    removed: parsed.removed,
    preview: binary || shown.length === 0 ? null : shown.join("\n"),
    binary,
    noNewlineAtEnd: parsed.noNewlineAtEnd
  }
}
