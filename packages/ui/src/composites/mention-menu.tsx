import { FileIcon } from "../components/file-icon.js"
import { VirtualList } from "../components/virtual-list.js"
import { cn } from "../lib/cn.js"

const pathKey = (path: string) => path

function MentionRow(path: string) {
  const name = path.split("/").pop() ?? path
  const dir = path.slice(0, path.length - name.length)
  return (
    <span className="flex min-w-0 items-center gap-2 px-3">
      <FileIcon path={path} />
      <span className="font-mono text-[12px] text-text-bright">{name}</span>
      {dir && <span className="truncate font-mono text-[10.5px] text-dim">{dir}</span>}
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
  onSelect,
  onHover,
  className
}: {
  files: ReadonlyArray<string>
  activeIndex: number
  onSelect: (path: string) => void
  onHover?: (index: number) => void
  className?: string
}) {
  if (files.length === 0) return null
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-panel shadow-2xl", className)}>
      <VirtualList
        items={files}
        getKey={pathKey}
        getText={pathKey}
        renderRow={MentionRow}
        onSelect={onSelect}
        activeKey={files[activeIndex] ?? null}
        onActiveKeyChange={(path) => onHover?.(files.indexOf(path))}
        ariaLabel="Files"
      />
    </div>
  )
}
