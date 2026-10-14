import { useRef, useState, type MouseEvent, type ReactNode } from "react"
import { Undo2 } from "lucide-react"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { ContextMenu } from "../components/context-menu.js"

/** The tree row (Pierre renders rows in a shadow root) under a right-click, by its path. */
const rowPathOf = (event: MouseEvent): string | null => {
  for (const node of event.nativeEvent.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.itemPath !== undefined) return node.dataset.itemPath
  }
  return null
}

/**
 * Right-click a file row in `paths` → "Discard file changes" → confirm → `onDiscard`.
 * Rows outside `paths` (folders, files with nothing to discard) open no menu.
 */
export function DiscardFileMenu({
  paths,
  onDiscard,
  children
}: {
  readonly paths: ReadonlySet<string>
  readonly onDiscard: (path: string) => void
  readonly children: ReactNode
}) {
  const rowPath = useRef<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  return (
    <>
      <ContextMenu
        items={[
          {
            id: "discard-file-changes",
            label: "Discard file changes",
            icon: Undo2,
            tone: "danger",
            onSelect: () => setPending(rowPath.current)
          }
        ]}
      >
        <div
          className="contents"
          onContextMenu={(event) => {
            rowPath.current = rowPathOf(event)
            if (rowPath.current === null || !paths.has(rowPath.current)) event.preventDefault()
          }}
        >
          {children}
        </div>
      </ContextMenu>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Discard changes to ${pending?.split("/").pop() ?? "this file"}?`}
        description="All uncommitted changes to this file are permanently discarded. This can't be undone."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          if (pending !== null) onDiscard(pending)
        }}
      />
    </>
  )
}
