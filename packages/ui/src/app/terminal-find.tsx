import { forwardRef } from "react"
import { SearchField } from "../components/search-input.js"
import { KbdChip } from "../components/kbd.js"

export interface TerminalFindProps {
  readonly query: string
  readonly count: string
  readonly onChange: (query: string) => void
}

/** A shortcut-opened overlay composed from the same search field used elsewhere. */
export const TerminalFind = forwardRef<HTMLInputElement, TerminalFindProps>(({ query, count, onChange }, ref) => (
  <section data-terminal-find aria-label="Find in terminal" className="absolute inset-x-3 top-3 z-20 ml-auto max-w-sm rounded-lg bg-panel p-2 shadow-lg">
    <SearchField ref={ref} value={query} onChange={onChange} placeholder="Find in terminal…" count={<span role="status" aria-live="polite">{count}</span>} kbd={<KbdChip shortcut="esc" />} />
    <div className="mt-2 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-[11px] text-dim">
      <KbdChip shortcut="enter" /><span>next</span>
      <KbdChip shortcut="shift+enter" /><span>previous</span>
      <KbdChip shortcut="esc" /><span>close</span>
    </div>
  </section>
))
TerminalFind.displayName = "TerminalFind"
