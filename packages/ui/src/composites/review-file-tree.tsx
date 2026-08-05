import type { PrFileChange } from "@jingler/core"
import { PierreFileTree } from "../components/pierre-file-tree.js"
import type { JinglerFileStatus } from "../diff/pierre-model.js"

export interface ReviewFileTreeProps {
  readonly files: readonly PrFileChange[]
  readonly activePath: string | null
  readonly statusByPath: ReadonlyMap<string, JinglerFileStatus>
  readonly query: string
  readonly onSelectFile: (path: string) => void
}

/**
 * Code Review's stable tree contract. Pierre owns hierarchy, search projection,
 * keyboard focus, icons, Git status, and selection; review state stays outside.
 */
export function ReviewFileTree({
  files,
  activePath,
  statusByPath,
  query,
  onSelectFile
}: ReviewFileTreeProps) {
  const filePaths = files.map((file) => file.path)
  const selectablePaths = new Set(filePaths)

  return (
    <PierreFileTree
      paths={filePaths}
      gitStatus={filePaths.map((path) => ({
        path,
        status: statusByPath.get(path) ?? "modified"
      }))}
      selectedPaths={activePath === null ? [] : [activePath]}
      focusedPath={activePath ?? undefined}
      searchQuery={query.length === 0 ? null : query}
      searchable={false}
      searchMode="expand-matches"
      initialExpansion="open"
      flattenEmptyDirectories={false}
      density="compact"
      ariaLabel="Changed files tree"
      className="min-h-0 flex-1"
      onSelectionChange={(paths) => {
        const selected = paths.findLast((path) => selectablePaths.has(path))
        if (selected !== undefined) onSelectFile(selected)
      }}
    />
  )
}
