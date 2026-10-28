import { useMemo, type CSSProperties } from "react"
import type { AssetFileEntry } from "@jingler/core"
import type { FileTreeRowDecoration, FileTreeRowDecorationRenderer } from "@pierre/trees"
import { PierreFileTree } from "../components/pierre-file-tree.js"
import { DiscardFileMenu } from "../composites/discard-file-menu.js"
import { explorerMarkFor, explorerRowMarks, type ExplorerRowMark } from "./explorer-row-marks.js"

// Deep Java-style package paths ran names off the edge; stack every level flush.
const FLAT_TREE_STYLE = {
  "--trees-level-gap-override": "0px",
  "--trees-indent-guide-bg-override": "transparent"
} as CSSProperties

// The tree's shadow root cannot see page keyframes, so the pulse ships with the tree.
const AGENT_PULSE_CSS = `
@keyframes jingler-agent-pulse { 50% { opacity: 0.3; } }
span[title="Agent editing"] { animation: jingler-agent-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { span[title="Agent editing"] { animation: none; } }
`

const dot = (title: string, color: string): FileTreeRowDecoration => ({
  text: "•",
  title,
  parts: [{ text: "•", color }]
})

/** Neutral dots only: bright while the agent writes the file, muted afterwards. */
const fileDot = (mark: ExplorerRowMark): FileTreeRowDecoration | null => {
  if (mark.editingNow) return dot("Agent editing", "var(--sb-text-bright)")
  return mark.agentEdited ? dot("Edited by agent", "var(--sb-muted)") : null
}

export interface AssetAgentActivity {
  /** Repo-relative paths the agent has edited this session. */
  readonly editedPaths: readonly string[]
  /** The path being written right now; null once the run ends. */
  readonly editingPath: string | null
}

export interface AssetFileTreeProps {
  readonly entries: readonly AssetFileEntry[]
  readonly selectedPath: string | null
  readonly onSelectPath: (path: string) => void
  /** Right-click → "Discard file changes" on files with uncommitted edits. */
  readonly onDiscardFile?: (path: string) => void
  readonly agentActivity?: AssetAgentActivity
  readonly className?: string
}

function useAgentDecoration(
  entries: readonly AssetFileEntry[],
  activity: AssetAgentActivity | undefined
): FileTreeRowDecorationRenderer {
  const editedPaths = activity?.editedPaths
  const editingPath = activity?.editingPath ?? null
  const marks = useMemo(
    () => explorerRowMarks(entries, editedPaths ?? [], editingPath),
    [entries, editedPaths, editingPath]
  )
  // Pierre already dots folders that hold git changes; ours only covers agent edits it cannot see yet.
  const gitMarks = useMemo(() => explorerRowMarks(entries, [], null), [entries])
  return useMemo(
    () => ({ item }) => {
      const mark = explorerMarkFor(marks, item.path)
      if (mark === undefined) return null
      if (item.kind === "file") return fileDot(mark)
      const covered = explorerMarkFor(gitMarks, item.path)?.changedDescendant === true
      return mark.changedDescendant && !covered ? dot("Contains agent edits", "var(--sb-muted)") : null
    },
    [marks, gitMarks]
  )
}

/** Stable Jingler contract around Pierre Trees for repository asset browsing. */
export function AssetFileTree({
  entries,
  selectedPath,
  onSelectPath,
  onDiscardFile,
  agentActivity,
  className
}: AssetFileTreeProps) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries])
  const files = useMemo(() => new Set(paths), [paths])
  const selectedPaths = useMemo(() => (selectedPath === null ? [] : [selectedPath]), [selectedPath])
  // Only tracked files with edits have a HEAD version to restore.
  const discardable = useMemo(
    () => new Set(entries.filter((entry) => entry.status === "modified" || entry.status === "deleted").map((entry) => entry.path)),
    [entries]
  )
  const renderDecoration = useAgentDecoration(entries, agentActivity)
  const tree = (
    <PierreFileTree
      paths={paths}
      gitStatus={entries}
      selectedPaths={selectedPaths}
      focusedPath={selectedPath ?? undefined}
      searchable={false}
      initialExpansion={1}
      flattenEmptyDirectories
      density="compact"
      overscan={16}
      stickyFolders={false}
      ariaLabel="Repository files"
      className={className}
      style={FLAT_TREE_STYLE}
      renderRowDecoration={renderDecoration}
      unsafeCSS={AGENT_PULSE_CSS}
      onSelectionChange={(paths) => {
        const selected = paths.findLast((path) => files.has(path))
        if (selected !== undefined && selected !== selectedPath) onSelectPath(selected)
      }}
    />
  )
  return onDiscardFile === undefined ? (
    tree
  ) : (
    <DiscardFileMenu paths={discardable} onDiscard={onDiscardFile}>
      {tree}
    </DiscardFileMenu>
  )
}
