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

export { AnimatedBadge, type AnimatedBadgeProps, type AnimatedBadgeSize, type AnimatedBadgeStatus } from "./animated-badge.js"
export { Loader, type LoaderProps, type LoaderVariant } from "./loader.js"
