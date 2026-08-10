export interface UnifiedDiffStats {
  readonly added: number
  readonly removed: number
  readonly preview: string | null
  readonly binary: boolean
  readonly noNewlineAtEnd: boolean
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
