import { useRef } from "react"
import { cn } from "../lib/cn.js"

export interface FilterChipOption<T extends string> {
  readonly value: T
  readonly label: string
  /** Trailing count, e.g. `12` in "Changed 12". */
  readonly count?: number
}

/**
 * A single-select row of one-line chips ("All 214 · Agents 38 · Skills 176").
 * `radiogroup` semantics: one tab stop, ←/→ move the selection, Enter selects the
 * focused chip. Chips never wrap; a crowded row scrolls horizontally.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className
}: {
  options: ReadonlyArray<FilterChipOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (from: number, step: 1 | -1) => {
    const next = (from + step + options.length) % options.length
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("sb-no-scrollbar flex gap-1 overflow-x-auto", className)}>
      {options.map((option, i) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.count != null ? `${option.label} ${option.count}` : option.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") (e.preventDefault(), move(i, 1))
              else if (e.key === "ArrowLeft") (e.preventDefault(), move(i, -1))
              else if (e.key === "Enter") (e.preventDefault(), onChange(option.value))
            }}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-transparent px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "bg-surface text-text-bright"
                : "text-muted-foreground hover:bg-surface hover:text-text"
            )}
          >
            {option.label}
            {option.count != null && <span className="text-[11px] tabular-nums text-dim">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
