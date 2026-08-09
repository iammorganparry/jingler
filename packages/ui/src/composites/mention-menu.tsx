import { cn } from "../lib/cn.js"
import { Command, CommandItem, CommandList } from "../components/command.js"
import { FileIcon } from "../components/file-icon.js"

/**
 * The `@` code-reference palette — lists the session's worktree files so the
 * operator can reference code in a prompt. Presentational + controlled (the
 * composer owns the query/active index and filtering).
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
    <Command
      shouldFilter={false}
      className={cn(
        "rounded-xl border border-line shadow-2xl",
        className
      )}
    >
      <CommandList className="max-h-[260px]">
        {files.map((path, i) => {
          const name = path.split("/").pop() ?? path
          const dir = path.slice(0, path.length - name.length)
          return (
            <CommandItem
              key={path}
              value={path}
              aria-selected={i === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onSelect={() => onSelect(path)}
              onMouseEnter={() => onHover?.(i)}
              className={cn(i === activeIndex && "bg-surface")}
            >
              <FileIcon path={path} />
              <span className="font-mono text-[12px] text-text-bright">{name}</span>
              {dir && <span className="truncate font-mono text-[10.5px] text-dim">{dir}</span>}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
