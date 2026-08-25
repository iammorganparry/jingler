import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import { ChevronDown, Copy, ExternalLink } from "lucide-react"
import { cn } from "../../lib/cn.js"
import { FAST, SPRING } from "../../lib/motion.js"

export function MessageBubble({ tone = "assistant", children, expandable = false, className }: { tone?: "assistant" | "user" | "status"; children: ReactNode; expandable?: boolean; className?: string }) {
  const [open, setOpen] = useState(!expandable)
  const content = <div data-slot="message-bubble-content" className={cn("text-[13px] leading-relaxed", expandable && !open && "line-clamp-4")}>{children}</div>
  return <div data-slot="message-bubble" className={cn("max-w-full rounded-xl border px-3.5 py-2.5", tone === "user" ? "ml-auto border-brand/30 bg-brand/10 text-text-bright" : tone === "status" ? "border-line bg-sunken text-muted-foreground" : "border-line bg-panel text-text-body", className)}>{content}{expandable && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-text"><ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />{open ? "Show less" : "Show more"}</button>}</div>
}

export function AgentMessage({ from, avatar, name, meta, children, live = false, className }: { from: "user" | "assistant" | "system"; avatar?: ReactNode; name?: ReactNode; meta?: ReactNode; children: ReactNode; live?: boolean; className?: string }) {
  return <m.article data-slot="message" data-from={from} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={FAST} className={cn("flex w-full gap-2.5", from === "user" && "justify-end", className)}>{from !== "user" && avatar && <div className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-md bg-surface">{avatar}</div>}<div className={cn("min-w-0 max-w-[88%]", from === "user" && "items-end")}><div className="mb-1 flex items-center gap-2 text-[10px] text-dim">{name && <strong className="font-medium text-muted-foreground">{name}</strong>}{meta}{live && <span className="flex items-center gap-1 text-green"><span className="size-1.5 animate-pulse-dot rounded-full bg-green" />live</span>}</div><div data-slot="message-content">{children}</div></div></m.article>
}

export interface MessageScrollerProps {
  children: ReactNode
  followOutput?: boolean
  followThreshold?: number
  smooth?: boolean
  onFollowChange?: (following: boolean) => void
  label?: string
  busy?: boolean
  className?: string
  viewportClassName?: string
  contentClassName?: string
  viewportTestId?: string
  viewportRef?: Ref<HTMLDivElement>
  viewportProps?: Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "ref">
}

export function MessageScroller({ children, followOutput = true, followThreshold = 56, smooth = true, onFollowChange, label = "Conversation", busy, className, viewportClassName, contentClassName, viewportTestId, viewportRef: externalRef, viewportProps }: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(followOutput)
  const [following, setFollowingState] = useState(followOutput)
  const programmaticRef = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    if (typeof externalRef === "function") externalRef(node)
    else if (externalRef) externalRef.current = node
  }, [externalRef])
  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return
    followingRef.current = next
    setFollowingState(next)
    onFollowChange?.(next)
  }, [onFollowChange])
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport) return
    programmaticRef.current = true
    viewport.scrollTo?.({ top: viewport.scrollHeight, behavior })
    if (typeof viewport.scrollTo !== "function") viewport.scrollTop = viewport.scrollHeight
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { programmaticRef.current = false }, behavior === "smooth" ? 320 : 0)
  }, [])
  useLayoutEffect(() => {
    followingRef.current = followOutput
    setFollowingState(followOutput)
    if (!followOutput) return
    const frame = requestAnimationFrame(() => scrollToEnd("auto"))
    return () => cancelAnimationFrame(frame)
  }, [followOutput, scrollToEnd])
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (followOutput && followingRef.current) scrollToEnd(reduce || !smooth ? "auto" : "smooth")
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [followOutput, reduce, scrollToEnd, smooth])
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  const { onScroll, onWheel, onTouchStart, onKeyDown, ...rest } = viewportProps ?? {}
  return <div data-slot="message-scroller" className={cn("relative min-h-0", className)}><div ref={setViewportRef} role="region" aria-label={label} aria-busy={busy || undefined} data-testid={viewportTestId} {...rest} onScroll={event => { if (!programmaticRef.current) { const node = event.currentTarget; setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight <= followThreshold) } onScroll?.(event) }} onWheel={event => { programmaticRef.current = false; if (event.deltaY < 0) setFollowing(false); onWheel?.(event) }} onTouchStart={event => { programmaticRef.current = false; setFollowing(false); onTouchStart?.(event) }} onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) { programmaticRef.current = false; setFollowing(false) } onKeyDown?.(event) }} className={cn("h-full overflow-y-auto overscroll-contain", viewportClassName)}><div ref={contentRef} className={contentClassName}>{children}</div></div><AnimatePresence>{!following && <m.button type="button" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={SPRING} onClick={() => { setFollowing(true); scrollToEnd(reduce || !smooth ? "auto" : "smooth") }} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1.5 text-[10.5px] text-text shadow-lg hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring">Jump to latest</m.button>}</AnimatePresence></div>
}

export function StreamingResponse({ children, streaming = false, sources, onCopy, actions, className }: { children: ReactNode; streaming?: boolean; sources?: ReactNode; onCopy?: () => void; actions?: ReactNode; className?: string }) {
  const [showSources, setShowSources] = useState(false)
  return <div data-slot="streaming-response" className={cn("group", className)}><div className={cn(streaming && "jingler-streaming-text")}>{children}</div>{!streaming && (onCopy || actions || sources) && <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{onCopy && <button type="button" aria-label="Copy response" onClick={onCopy} className="rounded-md p-1 text-dim hover:bg-surface hover:text-text"><Copy className="size-3.5" /></button>}{actions}{sources && <button type="button" aria-expanded={showSources} onClick={() => setShowSources(value => !value)} className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-surface hover:text-text">Sources</button>}</div>}<AnimatePresence initial={false}>{showSources && <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING} className="overflow-hidden"><div className="mt-2 border-t border-line pt-2">{sources}</div></m.div>}</AnimatePresence></div>
}

export interface CitationItem { id: string; label: string; url?: string; excerpt?: string }
export function CitationMarker({ index, onClick }: { index: number; onClick?: () => void }) { return <button type="button" aria-label={`Open citation ${index}`} onClick={onClick} className="mx-0.5 inline-flex min-w-4 items-center justify-center rounded bg-blue/15 px-1 align-super font-mono text-[9px] text-blue hover:bg-blue/25">{index}</button> }
export function Citations({ items, className }: { items: ReadonlyArray<CitationItem>; className?: string }) {
  return <ol aria-label="Sources" className={cn("flex flex-col gap-1.5", className)}>{items.map((item, index) => <li key={item.id} className="rounded-lg border border-line bg-sunken p-2.5 text-[11px]"><div className="flex gap-2"><span className="font-mono text-blue">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-1 font-medium text-text-bright">{item.label}{item.url && <a href={item.url} aria-label={`Open ${item.label}`}><ExternalLink className="size-3" /></a>}</div>{item.excerpt && <p className="mt-1 text-muted-foreground">{item.excerpt}</p>}</div></div></li>)}</ol>
}
