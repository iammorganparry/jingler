import { type ReactNode, useEffect, useRef, useState } from "react"
import { AnimatePresence, m, useReducedMotion, useScroll, useSpring } from "motion/react"
import { Check, X } from "lucide-react"
import { cn } from "../../lib/cn.js"
import { FAST, SPRING, SPRING_SOFT } from "../../lib/motion.js"

export function Marquee({ children, direction = "horizontal", duration = 18, pauseOnHover = true, className }: { children: ReactNode; direction?: "horizontal" | "vertical"; duration?: number; pauseOnHover?: boolean; className?: string }) {
  const reduce = useReducedMotion()
  return <div className={cn("group overflow-hidden", className)}><div className={cn("flex w-max gap-4", direction === "vertical" && "flex-col", !reduce && (direction === "horizontal" ? "animate-[beui-marquee_var(--duration)_linear_infinite]" : "animate-[beui-marquee-y_var(--duration)_linear_infinite]"), pauseOnHover && "group-hover:[animation-play-state:paused]")} style={{ "--duration": `${duration}s` } as React.CSSProperties}>{children}{children}</div></div>
}

export function AnimatedText({ children, mode = "fade", className }: { children: ReactNode; mode?: "fade" | "shimmer" | "spring"; className?: string }) {
  if (mode === "shimmer") return <span className={cn("bg-[linear-gradient(100deg,var(--sb-muted),var(--sb-text-bright),var(--sb-muted))] bg-[length:220%_100%] bg-clip-text text-transparent animate-shine", className)}>{children}</span>
  return <m.span initial={{ opacity: 0, y: mode === "spring" ? 6 : 0 }} animate={{ opacity: 1, y: 0 }} transition={mode === "spring" ? SPRING : FAST} className={className}>{children}</m.span>
}

export function AnimatedNumber({ value, format = value => String(value), className }: { value: number; format?: (value: number) => string; className?: string }) {
  return <span className={cn("relative inline-flex overflow-hidden font-mono tabular-nums", className)}><AnimatePresence mode="popLayout" initial={false}><m.span key={value} initial={{ y: "70%", opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: "-70%", opacity: 0 }} transition={SPRING}>{format(value)}</m.span></AnimatePresence></span>
}

export function AnimatedBadge({ children, tone = "neutral", pulse = false, icon, className }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "error" | "info"; pulse?: boolean; icon?: ReactNode; className?: string }) {
  const tones = { neutral: "bg-hover text-text", success: "bg-green/15 text-green", warning: "bg-yellow/15 text-yellow", error: "bg-red/15 text-red", info: "bg-blue/15 text-blue" }
  return <m.span layout transition={SPRING} className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px]", tones[tone], pulse && "animate-pulse-dot", className)}>{icon}<AnimatePresence mode="popLayout" initial={false}><m.span key={String(children)} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>{children}</m.span></AnimatePresence></m.span>
}

export function ActionSwap({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return <span className={cn("relative inline-grid overflow-hidden", className)}><AnimatePresence mode="popLayout" initial={false}><m.span key={value} initial={{ opacity: 0, filter: "blur(4px)", y: 4 }} animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} exit={{ opacity: 0, filter: "blur(4px)", y: -4 }} transition={FAST} className="col-start-1 row-start-1">{children}</m.span></AnimatePresence></span>
}

export interface ToastItem { id: string; title: string; description?: string; tone?: "neutral" | "success" | "error"; action?: { label: string; onClick: () => void } }
export function AnimatedToastStack({ items, onDismiss, className }: { items: ReadonlyArray<ToastItem>; onDismiss?: (id: string) => void; className?: string }) {
  return <div aria-live="polite" className={cn("flex w-80 flex-col gap-2", className)}><AnimatePresence initial={false}>{items.map(item => <m.div layout key={item.id} initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 24, scale: 0.97 }} drag="x" dragConstraints={{ left: 0, right: 0 }} onDragEnd={(_, info) => Math.abs(info.offset.x) > 60 && onDismiss?.(item.id)} transition={SPRING} className={cn("rounded-lg border bg-panel p-3 shadow-xl", item.tone === "success" ? "border-green/35" : item.tone === "error" ? "border-red/35" : "border-line")}><div className="flex gap-2"><div className="min-w-0 flex-1"><strong className="text-[12px] text-text-bright">{item.title}</strong>{item.description && <p className="mt-1 text-[11px] text-muted-foreground">{item.description}</p>}</div>{item.action && <button type="button" onClick={item.action.onClick} className="text-[11px] text-blue">{item.action.label}</button>}<button type="button" aria-label="Dismiss" onClick={() => onDismiss?.(item.id)} className="text-dim hover:text-text"><X className="size-3.5" /></button></div></m.div>)}</AnimatePresence></div>
}

export function ThemeToggle({ theme, onToggle, className }: { theme: "light" | "dark"; onToggle?: () => void; className?: string }) {
  return <button type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={onToggle} className={cn("relative flex size-8 items-center justify-center overflow-hidden rounded-lg border border-line bg-panel text-text", className)}><AnimatePresence mode="wait" initial={false}><m.span key={theme} initial={{ opacity: 0, rotate: -45, scale: 0.5 }} animate={{ opacity: 1, rotate: 0, scale: 1 }} exit={{ opacity: 0, rotate: 45, scale: 0.5 }} transition={SPRING}>{theme === "dark" ? "☾" : "☀"}</m.span></AnimatePresence></button>
}

export function ScrollProgress({ container, className }: { container?: React.RefObject<HTMLElement | null>; className?: string }) {
  const { scrollYProgress } = useScroll(container ? { container } : undefined)
  const scaleX = useSpring(scrollYProgress, SPRING)
  return <m.div aria-hidden style={{ scaleX, transformOrigin: "0 50%" }} className={cn("h-0.5 bg-brand", className)} />
}

export type LoaderVariant = "spinner" | "dots" | "bars" | "matrix" | "comet" | "percent" | "ascii"
export function Loader({ variant = "spinner", size = 16, value = 0, label = "Loading", className }: { variant?: LoaderVariant; size?: number; value?: number; label?: string; className?: string }) {
  const reduce = useReducedMotion()
  const common = cn("inline-flex items-center justify-center text-current", className)
  if (variant === "percent") return <span role="status" aria-label={label} className={cn(common, "font-mono text-[11px] tabular-nums")}>{Math.round(value)}%</span>
  if (variant === "ascii") return <AsciiLoader label={label} className={common} />
  if (variant === "dots" || variant === "matrix" || variant === "bars") return <span role="status" aria-label={label} className={cn(common, "gap-1")} style={{ width: size * 2, height: size }}>{[0,1,2].map(index => <m.span key={index} animate={reduce ? { opacity: [0.35,1,0.35] } : variant === "bars" ? { scaleY: [0.45,1,0.45] } : { y: [0,-3,0] }} transition={{ duration: .8, repeat: Infinity, delay: index * .12 }} className={cn("bg-current", variant === "bars" ? "h-full w-0.5 rounded-full" : "size-1 rounded-full")} />)}</span>
  if (variant === "comet") return <span role="status" aria-label={label} className={cn(common, "relative rounded-full border border-current/20")} style={{ width: size, height: size }}><m.span animate={reduce ? { opacity: [0.4,1,0.4] } : { rotate: 360 }} transition={{ duration: .8, repeat: Infinity, ease: "linear" }} className="absolute inset-0 rounded-full border-t-2 border-current" /></span>
  return <m.span role="status" aria-label={label} animate={reduce ? { opacity: [0.4,1,0.4] } : { rotate: 360 }} transition={{ duration: .8, repeat: Infinity, ease: "linear" }} className={cn(common, "rounded-full border-2 border-current/20 border-t-current")} style={{ width: size, height: size }} />
}

function AsciiLoader({ label, className }: { label: string; className?: string }) {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
  const [frame, setFrame] = useState(0)
  useEffect(() => { const id = window.setInterval(() => setFrame(current => (current + 1) % frames.length), 80); return () => window.clearInterval(id) }, [])
  return <span role="status" aria-label={label} className={cn("font-mono", className)}>{frames[frame]}</span>
}
