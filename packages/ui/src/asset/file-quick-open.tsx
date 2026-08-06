import { useMemo } from "react"
import type { AssetFileEntry } from "@jingler/core"
import { CommandPalette } from "../app/command-palette.js"
import { PALETTE_GROUP, type PaletteItem } from "../app/command-palette-model.js"

export interface FileQuickOpenProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly entries: ReadonlyArray<AssetFileEntry>
  readonly sessionTitle?: string
  readonly loading?: boolean
  readonly error?: string | null
  readonly onOpenPath: (path: string) => void
}

const parts = (path: string): { readonly name: string; readonly directory?: string } => {
  const segments = path.split("/")
  const name = segments.pop() ?? path
  const directory = segments.join("/")
  return directory.length === 0 ? { name } : { name, directory }
}

/** Focused-session file picker built on the same cmdk surface and fuzzy scorer. */
export function FileQuickOpen({
  open,
  onOpenChange,
  entries,
  sessionTitle,
  loading = false,
  error = null,
  onOpenPath
}: FileQuickOpenProps) {
  const items = useMemo<ReadonlyArray<PaletteItem>>(
    () =>
      entries.map((entry) => {
        const { name, directory } = parts(entry.path)
        return {
          id: `file:${entry.path}`,
          kind: "file",
          label: name,
          detail: directory,
          group: PALETTE_GROUP.files,
          run: () => onOpenPath(entry.path)
        }
      }),
    [entries, onOpenPath]
  )
  const suffix = sessionTitle?.trim()
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      placeholder={suffix ? `Open a file in ${suffix}…` : "Open a file in the focused session…"}
      emptyMessage={
        loading
          ? "Loading repository files…"
          : error ?? "No matching files in this session"
      }
      testId="file-quick-open"
    />
  )
}
