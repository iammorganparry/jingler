import type { PrFileChange } from "@jingler/core"
import type { FileTreeRowDecorationRenderer } from "@pierre/trees"
import { useMemo, type CSSProperties } from "react"
import { PierreFileTree } from "../components/pierre-file-tree.js"
import { DiscardFileMenu } from "./discard-file-menu.js"
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
  /** Right-click → "Discard file changes". Omit for sources with nothing local to discard. */
  readonly onDiscardFile?: (path: string) => void
}

/**
 * Code Review's stable tree contract. Pierre owns hierarchy, search projection,
 * keyboard focus, icons, Git status, and selection; review state stays outside.
 */
function countDecoration(additions: number, deletions: number) {
  const parts = [
    ...(additions > 0 ? [{ text: `+${additions}`, color: "var(--sb-diff-add-fg)" }] : []),
    ...(deletions > 0 ? [{ text: `${additions > 0 ? " " : ""}−${deletions}`, color: "var(--sb-diff-del-fg)" }] : [])
  ]
  return parts.length === 0 ? null : { text: parts.map((part) => part.text).join(""), parts }
}

export function ReviewFileTree({
  files,
  activePath,
  statusByPath,
  query,
  onSelectFile,
  onDiscardFile
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
      return file === undefined ? null : countDecoration(file.additions, file.deletions)
    },
    [countsByPath]
  )
  const selectablePaths = useMemo(() => new Set(filePaths), [filePaths])
  // Added/untracked files have no HEAD version to restore.
  const discardablePaths = useMemo(
    () => new Set(filePaths.filter((path) => !["added", "untracked"].includes(statusByPath.get(path) ?? ""))),
    [filePaths, statusByPath]
  )

  const tree = (
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
  return onDiscardFile === undefined ? (
    tree
  ) : (
    <DiscardFileMenu paths={discardablePaths} onDiscard={onDiscardFile}>
      {tree}
    </DiscardFileMenu>
  )
}
