import { useCallback } from "react"
import { FileIcon } from "../components/file-icon.js"
import { HighlightMatch } from "../components/highlight-match.js"
import { VirtualList } from "../components/virtual-list.js"
import { AutocompleteMenu } from "./autocomplete-menu.js"

const pathKey = (path: string) => path
const filesGroup = () => "Files"

/**
 * One file row. Rows never wrap: the directory shrinks with an ellipsis while
 * the file name stays readable, so a long path truncates in the middle.
 */
function MentionRow({ path, query }: { path: string; query: string }) {
  const name = path.split("/").pop() ?? path
  const dir = path.slice(0, path.length - name.length)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 px-3 whitespace-nowrap">
      <FileIcon path={path} />
      {dir && <span className="min-w-0 truncate font-mono text-[10.5px] text-dim">{dir}</span>}
      <span className="max-w-[70%] flex-none truncate font-mono text-[12px] text-text-bright">
        <HighlightMatch text={name} query={query} />
      </span>
    </span>
  )
}

/**
 * The `@` code-reference palette — lists the session's worktree files so the
 * operator can reference code in a prompt. Presentational + controlled (the
 * composer owns the query/active index and filtering); the list is windowed so
 * every matching file is reachable, not just the first few.
 */
export function MentionMenu({
  files,
  activeIndex,
  query = "",
  onSelect,
  onHover,
  className
}: {
  files: ReadonlyArray<string>
  activeIndex: number
  query?: string
  onSelect: (path: string) => void
  onHover?: (index: number) => void
  className?: string
}) {
  const renderRow = useCallback((path: string) => <MentionRow path={path} query={query} />, [query])
  return (
    <AutocompleteMenu trigger="@" query={query} empty={files.length === 0} className={className}>
      <VirtualList
        items={files}
        getKey={pathKey}
        getText={pathKey}
        getGroup={filesGroup}
        renderRow={renderRow}
        onSelect={onSelect}
        activeKey={files[activeIndex] ?? null}
        onActiveKeyChange={(path) => onHover?.(files.indexOf(path))}
        ariaLabel="Files"
      />
    </AutocompleteMenu>
  )
}
