import { useMemo } from "react"
import type { AssetFileEntry } from "@jingler/core"
import { PierreFileTree } from "../components/pierre-file-tree.js"

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
      searchable
      initialExpansion={1}
      flattenEmptyDirectories
      density="compact"
      overscan={16}
      stickyFolders={false}
      ariaLabel="Repository files"
      className={className}
      onSelectionChange={(paths) => {
        const selected = paths.findLast((path) => files.has(path))
        if (selected !== undefined && selected !== selectedPath) onSelectPath(selected)
      }}
    />
  )
}
