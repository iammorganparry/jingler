import { useMemo, type CSSProperties } from "react"
import type { AssetFileEntry } from "@jingler/core"
import { PierreFileTree } from "../components/pierre-file-tree.js"

// Deep Java-style package paths ran names off the edge; stack every level flush.
const FLAT_TREE_STYLE = {
  "--trees-level-gap-override": "0px",
  "--trees-indent-guide-bg-override": "transparent"
} as CSSProperties

export interface AssetFileTreeProps {
  readonly entries: readonly AssetFileEntry[]
  readonly selectedPath: string | null
  readonly onSelectPath: (path: string) => void
  readonly className?: string
}

/** Stable Jingler contract around Pierre Trees for repository asset browsing. */
export function AssetFileTree({
  entries,
  selectedPath,
  onSelectPath,
  className
}: AssetFileTreeProps) {
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries])
  const files = useMemo(() => new Set(paths), [paths])
  const selectedPaths = useMemo(() => (selectedPath === null ? [] : [selectedPath]), [selectedPath])
  return (
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
      onSelectionChange={(paths) => {
        const selected = paths.findLast((path) => files.has(path))
        if (selected !== undefined && selected !== selectedPath) onSelectPath(selected)
      }}
    />
  )
}
