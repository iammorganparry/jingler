import * as React from "react"
import { Search, X } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * The 32px search field — a leading magnifier, a controlled value, and a trailing
 * slot that is the clear (✕) button once there's text, else an optional `count`
 * (results) and `kbd` hint. Esc clears a non-empty field. Used for the session
 * filter, the PR/issue pickers, the Agents & skills list, etc. Forwards its ref
 * so callers can focus it from a shortcut.
 */
export const SearchField = React.forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    /** Hint shown on the right while the field is empty (e.g. a `⌘K` Kbd). */
    kbd?: React.ReactNode
    /** Result count shown next to the clear button while there's text (e.g. "12 results"). */
    count?: React.ReactNode
    autoFocus?: boolean
    className?: string
    "aria-label"?: string
  }
>(({ value, onChange, placeholder = "Search…", kbd, count, autoFocus, className, "aria-label": ariaLabel }, ref) => (
  <div
    className={cn(
      "flex h-8 items-center gap-2 rounded-lg border border-line bg-transparent px-3 text-[13px] text-dim transition-colors duration-150 hover:border-line-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
      className
    )}
  >
    <Search size={14} className="flex-none" />
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.preventDefault()
          e.stopPropagation()
          onChange("")
        }
      }}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel ?? placeholder}
      className="min-w-0 flex-1 bg-transparent text-text-body outline-none placeholder:text-dim"
    />
    {value && count != null && <span className="flex-none whitespace-nowrap text-[11px] text-dim">{count}</span>}
    {value ? (
      <button
        type="button"
        onClick={() => onChange("")}
        aria-label="Clear"
        className="flex-none text-dim transition-colors hover:text-text"
      >
        <X size={13} />
      </button>
    ) : (
      kbd
    )}
  </div>
))
SearchField.displayName = "SearchField"

/** Kept for plugin-sdk callers; same component as {@link SearchField}. */
export const SearchInput = SearchField
