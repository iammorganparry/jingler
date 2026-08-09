import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "../lib/cn.js"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "./command.js"
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js"

export interface ChipOption<T extends string> {
  value: T
  label: ReactNode
  description?: string
  searchText?: string
}

export interface ChipGroup<T extends string> {
  label: string
  options: ReadonlyArray<ChipOption<T>>
}

const textOf = <T extends string>(option: ChipOption<T>): string =>
  option.searchText ?? (typeof option.label === "string" ? option.label : option.value)

const includesSearch = (value: string, search: string, keywords?: ReadonlyArray<string>): number => {
  const query = search.trim().toLowerCase()
  if (query === "") return 1
  return [value, ...(keywords ?? [])].some((candidate) => candidate.toLowerCase().includes(query))
    ? 1
    : 0
}

/** A compact shadcn-style Command picker anchored to its composer control. */
export function ChipMenu<T extends string>({
  value,
  options,
  groups,
  onSelect,
  icon,
  searchable = false,
  searchPlaceholder = "Search…",
  emptyLabel = "No matches",
  disabled = false,
  trigger,
  renderTrailing,
  side = "top",
  matchTriggerWidth = false,
  appearance = "chip",
  ariaLabel,
  className
}: {
  value: T
  options?: ReadonlyArray<ChipOption<T>>
  groups?: ReadonlyArray<ChipGroup<T>>
  onSelect?: (value: T) => void
  icon?: ReactNode
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
  disabled?: boolean
  trigger?: (state: { current: ChipOption<T> | undefined; open: boolean }) => ReactNode
  renderTrailing?: (option: ChipOption<T>) => ReactNode
  side?: "top" | "bottom"
  matchTriggerWidth?: boolean
  appearance?: "chip" | "quiet"
  ariaLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const sections: ReadonlyArray<ChipGroup<T>> = useMemo(
    () => groups ?? [{ label: "", options: options ?? [] }],
    [groups, options]
  )
  const current = sections.flatMap((section) => section.options).find((option) => option.value === value)
  const showHeaders = sections.length > 1

  useEffect(() => {
    if (!open || !searchable) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, searchable])

  const pick = (next: T) => {
    onSelect?.(next)
    setOpen(false)
  }

  const chip = trigger ? (
    trigger({ current, open })
  ) : (
    <span
      title={typeof (current?.label ?? value) === "string" ? String(current?.label ?? value) : undefined}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-md font-mono text-[11px] text-text-bright",
        appearance === "chip"
          ? "border border-line bg-surface px-2 py-[3px]"
          : "px-1.5 py-1 text-muted-foreground transition-colors",
        !disabled &&
          (appearance === "chip"
            ? "cursor-pointer hover:border-line-strong"
            : "cursor-pointer hover:bg-surface hover:text-text-bright"),
        className
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{current?.label ?? value}</span>
      {!disabled && <ChevronDown size={11} className="flex-none text-dim" />}
    </span>
  )

  if (disabled) return chip

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "min-w-0 outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring",
            appearance === "quiet" && "inline-flex min-h-10 items-center",
            trigger && "w-full text-left"
          )}
        >
          {chip}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        style={matchTriggerWidth ? { width: "var(--radix-popover-trigger-width)" } : undefined}
        className={cn(
          "overflow-hidden p-0",
          !matchTriggerWidth && (searchable ? "w-[280px]" : "w-[210px]")
        )}
      >
        <Command loop filter={includesSearch}>
          {searchable && <CommandInput ref={inputRef} placeholder={searchPlaceholder} />}
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {sections.map((section, index) => (
              <CommandGroup
                key={section.label || index}
                heading={showHeaders ? section.label : undefined}
              >
                {section.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[section.label, textOf(option)]}
                    onSelect={() => pick(option.value)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-[10.5px] text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {option.value === value && <Check size={13} className="flex-none text-blue" />}
                    {renderTrailing?.(option)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
