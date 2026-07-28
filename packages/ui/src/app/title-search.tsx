import { Search } from "lucide-react"
import { Kbd } from "../components/kbd.js"

/**
 * The global-search affordance in the title bar's centre.
 *
 * It is not a session filter any more — it is the mouth of the command palette,
 * which already jumps to sessions AND runs commands (the two searches were the
 * same search). Clicking it, or typing a printable character while it is
 * focused, opens the palette; ⌘K opens it from anywhere. A typed character is
 * handed through as the palette's initial query so the keystroke that summoned
 * it is not lost.
 */
export function TitleSearch({
  onOpen
}: {
  /** Open the palette, optionally seeded with the character just typed. */
  onOpen: (initialQuery?: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen()}
      onKeyDown={(e) => {
        // Let ⌘K and friends reach the window-level handler; only a bare
        // printable character means "start searching".
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key.length === 1) {
          e.preventDefault()
          onOpen(e.key)
        }
      }}
      aria-label="Search sessions and commands"
      data-testid="global-search"
      className="flex w-[320px] items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-[7px] text-[12.5px] text-dim outline-none transition-colors hover:border-line-strong focus-visible:border-line-strong focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Search size={13} className="flex-none" />
      <span className="flex-1 text-left">Search…</span>
      <Kbd>⌘K</Kbd>
    </button>
  )
}
