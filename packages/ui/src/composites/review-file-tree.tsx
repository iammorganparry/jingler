import type { PrFileChange } from "@jingler/core"
import type { FileTreeRowDecorationRenderer } from "@pierre/trees"
import { useMemo, type CSSProperties } from "react"
import { PierreFileTree } from "../components/pierre-file-tree.js"
import type { JinglerFileStatus } from "../diff/pierre-model.js"

/** Status letters stay neutral: the +/− counts carry the only colour, and those are diff tokens. */
const NEUTRAL_STATUS_STYLE = {
  "--trees-git-added-color-override": "var(--sb-muted)",
  "--trees-git-deleted-color-override": "var(--sb-muted)",
  "--trees-git-modified-color-override": "var(--sb-muted)",
  "--trees-git-renamed-color-override": "var(--sb-muted)",
  "--trees-git-untracked-color-override": "var(--sb-muted)"
} as CSSProperties

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
  const filePaths = useMemo(() => files.map((file) => file.path), [files])
  const gitStatus = useMemo(
    () => filePaths.map((path) => ({
      path,
      status: statusByPath.get(path) ?? "modified" as const
    })),
    [filePaths, statusByPath]
  )
  const countsByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const renderCounts = useMemo<FileTreeRowDecorationRenderer>(
    () => ({ item }) => {
      const file = countsByPath.get(item.path)
      if (file === undefined) return null
      const parts = [
        ...(file.additions > 0 ? [{ text: `+${file.additions}`, color: "var(--sb-diff-add-fg)" }] : []),
        ...(file.deletions > 0 ? [{ text: `${file.additions > 0 ? " " : ""}−${file.deletions}`, color: "var(--sb-diff-del-fg)" }] : [])
      ]
      return parts.length === 0 ? null : { text: parts.map((part) => part.text).join(""), parts }
    },
    [countsByPath]
  )
  const selectablePaths = useMemo(() => new Set(filePaths), [filePaths])

  return (
    <PierreFileTree
      paths={filePaths}
      gitStatus={gitStatus}
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
      style={NEUTRAL_STATUS_STYLE}
      renderRowDecoration={renderCounts}
      onSelectionChange={(paths) => {
        const selected = paths.findLast((path) => selectablePaths.has(path))
        if (selected !== undefined) onSelectFile(selected)
      }}
    />
  )
}
