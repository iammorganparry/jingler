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
import { PreviewRail, type PreviewRailItem } from "../../components/beui/overlays.js"

export function MessageBubble({ tone = "assistant", children, expandable = false, className }: { tone?: "assistant" | "user" | "status"; children: ReactNode; expandable?: boolean; className?: string }) {
  const [open, setOpen] = useState(!expandable)
  const content = <div data-slot="message-bubble-content" className={cn("text-[13px] leading-relaxed", expandable && !open && "line-clamp-4")}>{children}</div>
  return <div data-slot="message-bubble" className={cn("max-w-full rounded-xl border px-3.5 py-2.5", tone === "user" ? "ml-auto border-brand/30 bg-brand/10 text-text-bright" : tone === "status" ? "border-line bg-sunken text-muted-foreground" : "border-line bg-panel text-text-body", className)}>{content}{expandable && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-text"><ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />{open ? "Show less" : "Show more"}</button>}</div>
}

export function AgentMessage({ from, avatar, name, meta, children, live = false, className }: { from: "user" | "assistant" | "system"; avatar?: ReactNode; name?: ReactNode; meta?: ReactNode; children: ReactNode; live?: boolean; className?: string }) {
  return <m.article data-slot="message" data-from={from} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={FAST} className={cn("flex w-full gap-2.5", from === "user" && "justify-end", className)}>{from !== "user" && avatar && <div className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-md bg-surface">{avatar}</div>}<div className={cn("min-w-0 max-w-[88%]", from === "user" && "items-end")}><div className="mb-1 flex items-center gap-2 text-[10px] text-dim">{name && <strong className="font-medium text-muted-foreground">{name}</strong>}{meta}{live && <span className="flex items-center gap-1 text-green"><span className="size-1.5 animate-pulse-dot rounded-full bg-green" />live</span>}</div><div data-slot="message-content">{children}</div></div></m.article>
}

const PREVIEW_TITLE_LENGTH = 56
const PREVIEW_DESCRIPTION_LENGTH = 88

function truncateMessageText(text: string, limit: number) {
  if (text.length <= limit) return text
  const excerpt = text.slice(0, limit)
  const boundary = excerpt.lastIndexOf(" ")
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`
}

function getMessageText(message: HTMLElement) {
  const surface = message.querySelector<HTMLElement>('[data-slot="message-bubble-content"]') ?? message.querySelector<HTMLElement>('[data-slot="message-content"]') ?? message
  return (surface.textContent ?? "").replace(/\s+/g, " ").trim()
}

export function createMessageRailPreview(text: string, assistantResponse = "") {
  const normalized = text.replace(/\s+/g, " ").trim()
  const response = assistantResponse.replace(/\s+/g, " ").trim()
  if (!normalized) return { label: "Message", description: undefined }
  if (normalized.length <= PREVIEW_TITLE_LENGTH) return { label: normalized, description: response ? truncateMessageText(response, PREVIEW_DESCRIPTION_LENGTH) : undefined }
  const titleExcerpt = normalized.slice(0, PREVIEW_TITLE_LENGTH)
  const titleBoundary = titleExcerpt.lastIndexOf(" ")
  const titleEnd = titleBoundary > PREVIEW_TITLE_LENGTH * 0.65 ? titleBoundary : PREVIEW_TITLE_LENGTH
  const label = `${normalized.slice(0, titleEnd).trim()}…`
  const description = response || normalized.slice(titleEnd).trim()
  return { label, description: description ? truncateMessageText(description, PREVIEW_DESCRIPTION_LENGTH) : undefined }
}

function getMessagePreview(message: HTMLElement, assistantResponse?: HTMLElement) {
  return createMessageRailPreview(getMessageText(message), assistantResponse ? getMessageText(assistantResponse) : "")
}

export interface MessageScrollerProps extends ComponentPropsWithoutRef<"div"> {
  followOutput?: boolean
  followThreshold?: number
  smooth?: boolean
  onFollowChange?: (following: boolean) => void
  label?: string
  busy?: boolean
  navigation?: "rail"
  navigationLabel?: string
  /** Controlled rail data for virtualized transcripts whose rows are not all mounted. */
  navigationItems?: ReadonlyArray<PreviewRailItem>
  navigationActiveId?: string
  onNavigationSelect?: (item: PreviewRailItem) => void
  viewportClassName?: string
  contentClassName?: string
  railClassName?: string
  viewportTestId?: string
  viewportRef?: Ref<HTMLElement>
  viewportProps?: Omit<ComponentPropsWithoutRef<"section">, "children" | "className" | "ref">
  contentProps?: Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "ref">
}

function nearestRailTarget(targets: ReadonlyArray<readonly [string, HTMLElement]>, viewportCenter: number): string {
    let nearestId = targets[0]?.[0] ?? ""
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const [id, element] of targets) {
      const rect = element.getBoundingClientRect()
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter)
      if (distance < nearestDistance) { nearestDistance = distance; nearestId = id }
    }
  return nearestId
}

function scrollRailViewport(viewport: HTMLElement, top: number, behavior: ScrollBehavior): void {
  if (typeof viewport.scrollTo === "function") viewport.scrollTo({ top, behavior })
  else viewport.scrollTop = top
}

export function MessageScroller({ followOutput = true, followThreshold = 56, smooth = true, onFollowChange, label = "Conversation", busy, navigation, navigationLabel = "Message navigation", navigationItems, navigationActiveId, onNavigationSelect, viewportClassName, contentClassName, railClassName, viewportTestId, viewportRef: externalViewportRef, viewportProps, contentProps, className, children, ...props }: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false
  const viewportRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(followOutput)
  const programmaticScrollRef = useRef(false)
  const scrollTimerRef = useRef<number | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  const railFrameRef = useRef<number | undefined>(undefined)
  const railIdRef = useRef(new WeakMap<HTMLElement, string>())
  const railIdCounterRef = useRef(0)
  const railTargetsRef = useRef(new Map<string, HTMLElement>())
  const [railItems, setRailItems] = useState<PreviewRailItem[]>([])
  const [activeRailId, setActiveRailId] = useState("")
  const [railOverflowing, setRailOverflowing] = useState(false)
  const controlledRail = navigationItems !== undefined
  const visibleRailItems = navigationItems ?? railItems
  const railVisible = controlledRail ? visibleRailItems.length > 1 : railOverflowing
  const { onScroll: onViewportScroll, onWheel: onViewportWheel, onTouchStart: onViewportTouchStart, onKeyDown: onViewportKeyDown, ...restViewportProps } = viewportProps ?? {}

  const setViewportRef = useCallback((node: HTMLElement | null) => {
    viewportRef.current = node
    if (typeof externalViewportRef === "function") externalViewportRef(node)
    else if (externalViewportRef) externalViewportRef.current = node
  }, [externalViewportRef])

  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return
    followingRef.current = next
    onFollowChange?.(next)
  }, [onFollowChange])

  const updateActiveRailItem = useCallback(() => {
    if (navigation !== "rail" || controlledRail) return
    const viewport = viewportRef.current
    const targets = [...railTargetsRef.current.entries()]
    if (!viewport || targets.length === 0) return
    const viewportRect = viewport.getBoundingClientRect()
    if (viewport.scrollTop <= followThreshold) { setActiveRailId(targets[0]?.[0] ?? ""); return }
    const distanceFromEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distanceFromEnd <= followThreshold) { setActiveRailId(targets.at(-1)?.[0] ?? ""); return }
    const viewportCenter = viewportRect.top + viewportRect.height / 2
    const nearestId = nearestRailTarget(targets, viewportCenter)
    setActiveRailId(nearestId)
  }, [controlledRail, followThreshold, navigation])

  const syncRailItems = useCallback(() => {
    if (navigation !== "rail" || controlledRail) return
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return
    const messages = Array.from(content.querySelectorAll<HTMLElement>('[data-slot="message"]'))
    const targets = new Map<string, HTMLElement>()
    const nextItems = messages.map((message, index) => {
      let id = railIdRef.current.get(message)
      if (!id) { railIdCounterRef.current += 1; id = `message-rail-${railIdCounterRef.current}`; railIdRef.current.set(message, id) }
      targets.set(id, message)
      const sender = message.dataset.from ?? "conversation"
      const assistantResponse = sender === "user" ? messages.slice(index + 1).find(candidate => candidate.dataset.from === "assistant") : undefined
      const preview = getMessagePreview(message, assistantResponse)
      return { id, label: preview.label, description: preview.description, ariaLabel: `Go to ${sender} message ${index + 1} of ${messages.length}` }
    })
    railTargetsRef.current = targets
    setRailItems(current => {
      const unchanged = current.length === nextItems.length && current.every((item, index) => item.id === nextItems[index]?.id && item.label === nextItems[index]?.label && item.description === nextItems[index]?.description && item.ariaLabel === nextItems[index]?.ariaLabel)
      return unchanged ? current : nextItems
    })
    setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1)
  }, [controlledRail, navigation])

  const scheduleRailSync = useCallback(() => {
    if (navigation !== "rail" || controlledRail) return
    if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current)
    railFrameRef.current = requestAnimationFrame(() => { syncRailItems(); updateActiveRailItem() })
  }, [controlledRail, navigation, syncRailItems, updateActiveRailItem])

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport) return
    // Already pinned to the live edge: issuing another scrollTo would only
    // spawn a fresh scroll animation and a scroll event for handleScroll to
    // interpret. This early-out is the brake that lets the
    // resize → scroll → virtualizer-measure → resize cycle converge instead of
    // cycling forever (a runaway renderer leaked gigabytes through it).
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1) return
    programmaticScrollRef.current = true
    if (typeof viewport.scrollTo === "function") viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    else viewport.scrollTop = viewport.scrollHeight
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = window.setTimeout(() => { programmaticScrollRef.current = false }, behavior === "smooth" ? 320 : 100)
  }, [])

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (programmaticScrollRef.current) {
      // Our own catch-up scroll in flight. Scroll events dispatch on the frame
      // AFTER scrollTo, so a timer alone races them — an instant scroll's 0ms
      // timer could clear the flag first, and this handler then read the jump
      // as the user scrolling and flapped `following`. Landing at the bottom is
      // the reliable completion signal; the timer stays as a backstop for
      // scrolls that get cancelled before they land.
      if (distance <= 1) programmaticScrollRef.current = false
      updateActiveRailItem()
      return
    }
    setFollowing(distance <= followThreshold)
    updateActiveRailItem()
  }, [followThreshold, setFollowing, updateActiveRailItem])

  useLayoutEffect(() => {
    followingRef.current = followOutput
    if (!followOutput) return
    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"))
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [followOutput, scrollToEnd])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      scheduleRailSync()
      // Instant, never smooth: while a turn streams, content resizes up to
      // once per frame (every token, every virtualizer re-measure), and
      // restarting a smooth animation on each resize kept the viewport
      // permanently mid-scroll — mounting and unmounting virtualized rows
      // along the animation path on every frame, indefinitely. An instant pin
      // converges in one hop; smooth catch-up remains for the one-shot rail
      // jump in scrollToRailItem, where it is a single user-visible motion.
      if (followOutput && followingRef.current) scrollToEnd("auto")
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [followOutput, scheduleRailSync, scrollToEnd])

  useEffect(() => {
    if (navigation !== "rail" || controlledRail) { railTargetsRef.current.clear(); setRailItems([]); setRailOverflowing(false); return }
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return
    scheduleRailSync()
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleRailSync)
    mutationObserver?.observe(content, { childList: true, characterData: true, subtree: true })
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleRailSync)
    resizeObserver?.observe(content); resizeObserver?.observe(viewport)
    return () => { mutationObserver?.disconnect(); resizeObserver?.disconnect() }
  }, [controlledRail, navigation, scheduleRailSync])

  useEffect(() => () => {
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current)
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current)
  }, [])

  const scrollToRailItem = useCallback((item: PreviewRailItem) => {
    const viewport = viewportRef.current
    const target = railTargetsRef.current.get(item.id)
    if (!viewport || !target) return
    const lastItem = railItems.at(-1)?.id === item.id
    setActiveRailId(item.id)
    const behavior = reduce || !smooth ? "auto" : "smooth"
    if (lastItem) { setFollowing(true); scrollToEnd(behavior); return }
    setFollowing(false)
    programmaticScrollRef.current = true
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const top = viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetRect.height) / 2
    scrollRailViewport(viewport, top, behavior)
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = window.setTimeout(() => { programmaticScrollRef.current = false }, behavior === "smooth" ? 320 : 0)
  }, [railItems, reduce, scrollToEnd, setFollowing, smooth])

  const viewport = <section ref={setViewportRef} aria-label={label} data-testid={viewportTestId} {...restViewportProps} onScroll={event => { handleScroll(); onViewportScroll?.(event) }} onWheel={event => { programmaticScrollRef.current = false; onViewportWheel?.(event) }} onTouchStart={event => { programmaticScrollRef.current = false; onViewportTouchStart?.(event) }} onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) programmaticScrollRef.current = false; onViewportKeyDown?.(event) }} className={cn("h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", navigation === "rail" ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "[scrollbar-gutter:stable]", viewportClassName, navigation === "rail" && railVisible && "pr-10")}>
    <div ref={contentRef} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy} className={contentClassName} {...contentProps}>{children}</div>
  </section>

  return <div data-slot="message-scroller" className={cn("min-h-0", className)} {...props}>{navigation === "rail" ? <PreviewRail items={railVisible ? visibleRailItems : []} label={navigationLabel} activeId={navigationActiveId ?? activeRailId} onItemSelect={onNavigationSelect ?? scrollToRailItem} previewSide="before" highlightActive itemSize={14} className="h-full min-h-0 overflow-hidden" previewContainerClassName="right-8 left-3" previewClassName="mr-1 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4" railClassName={cn("absolute inset-y-3 right-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-end [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-right", railVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0", railClassName)}>{viewport}</PreviewRail> : viewport}</div>
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
