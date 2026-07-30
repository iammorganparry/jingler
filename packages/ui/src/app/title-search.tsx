import { Search } from "lucide-react"
import { Kbd } from "../components/kbd.js"

/**
 * The app's global search, centred in the title bar.
 *
 * ## Why this is a button dressed as a field, and not a field
 *
 * Typing here does not filter anything in place — it opens the command palette,
 * which is already the thing that searches every session, every archived
 * session and every action. Two search implementations over one index is how
 * they drift apart, and the palette is the one with the fuzzy matcher, the
 * grouping and the keyboard model.
 *
 * So this is `<button>` rather than `<input>`: it looks like a field because
 * that is what makes an operator try it, and it behaves like a button because
 * pretending to accept text and then stealing the caret into a dialog is worse
 * than not accepting text at all. Screen readers get told it is a button, which
 * is the truth.
 *
 * The palette itself was keyboard-only before this — ⌘K and nothing on screen.
 * That is fine for the people who already know, and invisible to everyone else.
 */
export function TitleSearch({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search sessions and actions"
      aria-keyshortcuts="Meta+K"
      className="flex h-[30px] w-[min(52vw,560px)] items-center gap-2.5 rounded-lg border border-hairline bg-sunken px-3 text-[13px] text-dim outline-none transition-colors hover:border-line hover:text-text-body focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Search size={14} className="flex-none" />
      {/*
        `truncate` + `text-left` on a flexed span: at a narrow window this label
        gives ground before the ⌘K hint does. The hint is the part that teaches
        the faster route, so it is the part worth keeping when space runs out.
      */}
      <span className="min-w-0 flex-1 truncate text-left">Search sessions, actions…</span>
      <Kbd className="flex-none">⌘K</Kbd>
    </button>
  )
}
