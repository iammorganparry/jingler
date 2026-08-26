import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react"
import { AnimatePresence, LayoutGroup, animate, m, useReducedMotion } from "motion/react"
import { Check, ChevronDown, Search } from "lucide-react"
import { cn } from "../../lib/cn.js"
import { SPRING } from "../../lib/motion.js"
import { Button, type ButtonProps } from "../button.js"
import { Checkbox } from "../checkbox.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"
import { Toggle } from "../toggle.js"

export function ExpandableControl({ icon, label, expanded, onExpandedChange, className }: {
  icon: ReactNode
  label: ReactNode
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  className?: string
}) {
  const [local, setLocal] = useState(false)
  const open = expanded ?? local
  const setOpen = (next: boolean) => {
    if (expanded === undefined) setLocal(next)
    onExpandedChange?.(next)
  }
  return (
    <m.button type="button" layout transition={SPRING} aria-expanded={open} onClick={() => setOpen(!open)} className={cn("inline-flex h-8 items-center gap-2 overflow-hidden rounded-lg border border-line bg-panel px-2.5 text-[12px] text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring", className)}>
      {icon}
      <AnimatePresence initial={false}>{open && <m.span initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }} transition={SPRING} className="whitespace-nowrap">{label}</m.span>}</AnimatePresence>
    </m.button>
  )
}

/** Compatibility export; Button is the canonical BeUI spring-pressed control. */
export function MotionButton(props: ButtonProps) {
  return <Button {...props} />
}

export function AnimatedCTAButton({ children, trailing = "→", ...props }: ButtonProps & { trailing?: ReactNode }) {
  return <Button {...props} className={cn("group overflow-hidden", props.className)}>{children}<span className="transition-transform duration-150 group-hover:translate-x-0.5">{trailing}</span></Button>
}

export interface MotionTabItem<T extends string> { value: T; label: ReactNode; disabled?: boolean }
export function MotionTabs<T extends string>({ items, value, onChange, variant = "pill", className }: {
  items: ReadonlyArray<MotionTabItem<T>>
  value: T
  onChange?: (value: T) => void
  variant?: "pill" | "underline" | "segment"
  className?: string
}) {
  const id = useId()
  return <LayoutGroup id={id}><div role="tablist" className={cn("inline-flex items-center gap-1", variant === "segment" && "rounded-lg border border-line bg-sunken p-1", className)}>{items.map(item => {
    const active = item.value === value
    return <button key={item.value} type="button" role="tab" aria-selected={active} disabled={item.disabled} onClick={() => onChange?.(item.value)} className={cn("relative rounded-md px-3 py-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "text-text-bright" : "text-muted-foreground hover:text-text")}>
      {active && <m.span layoutId="active" transition={SPRING} className={cn("absolute inset-0 -z-10", variant === "underline" ? "top-auto h-0.5 rounded-full bg-brand" : "rounded-md bg-surface shadow-sm")} />}
      {item.label}
    </button>
  })}</div></LayoutGroup>
}

export function MotionSwitch(props: React.ComponentProps<typeof Toggle>) {
  return <m.span whileTap={{ scale: 0.94 }} transition={SPRING} className="inline-flex"><Toggle {...props} /></m.span>
}

export function MotionInput({ label, error, success, left, right, className, disabled, id, onFocus, onBlur, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode
  error?: ReactNode
  success?: boolean
  left?: ReactNode
  right?: ReactNode
}) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const reduce = useReducedMotion()
  const fieldRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const hasError = Boolean(error)

  useEffect(() => {
    if (!fieldRef.current || reduce || !hasError) return
    animate(fieldRef.current, { x: [0, -6, 6, -4, 4, -2, 0] }, { duration: 0.45 })
  }, [hasError, reduce])

  return <div className={cn("flex flex-col gap-1.5", className)}>
    {label && <label htmlFor={inputId} className="px-1 text-sm font-medium text-text-bright">{label}</label>}
    <div ref={fieldRef} data-state={hasError ? "error" : success ? "success" : focused ? "focused" : "idle"} className={cn(
      "relative h-11 overflow-hidden rounded-full border border-line transition-colors duration-200",
      focused && !hasError && "border-text-bright/40 ring-2 ring-ring/40",
      hasError && "border-red ring-2 ring-red/25",
      disabled && "opacity-60"
    )}>
      {left && <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:size-4">{left}</span>}
      <input
        {...props}
        id={inputId}
        disabled={disabled}
        aria-invalid={hasError || undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onFocus={(event) => { setFocused(true); onFocus?.(event) }}
        onBlur={(event) => { setFocused(false); onBlur?.(event) }}
        className={cn(
          "h-full w-full bg-transparent text-base leading-6 text-text-bright caret-text-bright outline-none placeholder:text-muted-foreground/60",
          left ? "pl-10" : "pl-3.5",
          right || success ? "pr-10" : "pr-3.5",
          disabled && "cursor-not-allowed"
        )}
      />
      {success ? <m.svg viewBox="0 0 24 24" fill="none" className="absolute right-3.5 top-1/2 size-5 -translate-y-1/2 text-green">
        <m.path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" initial={reduce ? { pathLength: 1 } : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, ease: "easeOut" }} />
      </m.svg> : right ? <span className="absolute right-0 top-0 flex h-full items-center text-muted-foreground [&_button]:grid [&_button]:size-11 [&_button]:place-items-center [&_svg]:size-4">{right}</span> : null}
    </div>
    <AnimatePresence initial={false}>{error && <m.p id={`${inputId}-error`} role="alert" initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, filter: "blur(4px)" }} transition={{ duration: 0.2 }} className="px-1 text-xs text-red">{error}</m.p>}</AnimatePresence>
  </div>
}

export function MotionSelect({ value, onValueChange, placeholder, options, className }: {
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  options: ReadonlyArray<{ value: string; label: ReactNode }>
  className?: string
}) {
  return <Select value={value} onValueChange={onValueChange}><SelectTrigger className={className}><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>
}

export function Combobox({ options, value, onValueChange, placeholder = "Search…", className }: {
  options: ReadonlyArray<{ value: string; label: string; group?: string }>
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  className?: string
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => options.filter(option => option.label.toLowerCase().includes(query.toLowerCase())), [options, query])
  return <div className={cn("overflow-hidden rounded-lg border border-line bg-sunken", className)}>
    <label className="flex items-center gap-2 border-b border-line px-2.5"><Search className="size-3.5 text-dim" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={placeholder} className="h-8 min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-dim" /></label>
    <div role="listbox" className="max-h-48 overflow-auto p-1">{filtered.map(option => <button type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={() => onValueChange?.(option.value)} className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-surface", option.value === value ? "text-text-bright" : "text-muted-foreground")}>{option.label}{option.value === value && <Check className="size-3.5 text-green" />}</button>)}</div>
  </div>
}

export function MotionCheckbox(props: React.ComponentProps<typeof Checkbox>) {
  return <Checkbox {...props} />
}

export function RadioGroup({ value, onValueChange, options, className }: {
  value: string
  onValueChange?: (value: string) => void
  options: ReadonlyArray<{ value: string; label: ReactNode; disabled?: boolean }>
  className?: string
}) {
  return <div role="radiogroup" className={cn("flex flex-col gap-1", className)}>{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} disabled={option.disabled} onClick={() => onValueChange?.(option.value)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-text hover:bg-surface"><span className="flex size-4 items-center justify-center rounded-full border border-line-strong">{option.value === value && <m.span layoutId="radio-dot" transition={SPRING} className="size-2 rounded-full bg-brand" />}</span>{option.label}</button>)}</div>
}

export function RangeSlider({ value, min = 0, max = 100, step = 1, onChange, className }: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange?: (value: number) => void
  className?: string
}) {
  const percent = ((value - min) / (max - min)) * 100
  return <label className={cn("relative flex h-7 items-center", className)}><span className="absolute inset-x-0 h-1 rounded-full bg-line"><span className="block h-full rounded-full bg-brand" style={{ width: `${percent}%` }} /></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(Number(event.target.value))} className="absolute inset-0 w-full cursor-pointer opacity-0" /><m.span animate={{ left: `calc(${percent}% - 5px)` }} transition={SPRING} className="absolute size-3 rounded-sm border border-brand-hover bg-brand shadow" /></label>
}

export function WheelPicker({ value, onValueChange, options, label = "Choose a value", className }: {
  value: string
  onValueChange?: (value: string) => void
  options: ReadonlyArray<{ value: string; label: ReactNode }>
  label?: string
  className?: string
}) {
  return <div role="listbox" aria-label={label} className={cn("relative max-h-32 snap-y snap-mandatory overflow-y-auto rounded-lg border border-line bg-sunken p-1", className)}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => onValueChange?.(option.value)} className={cn("flex h-8 w-full snap-center items-center justify-center rounded-md text-[12px]", option.value === value ? "bg-surface font-semibold text-text-bright" : "text-muted-foreground")}>{option.label}</button>)}</div>
}
