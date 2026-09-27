import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useOpenAsset } from "../asset/open-asset-context.js"
import { resolveOpenablePath } from "../asset/path-detect.js"
import { cn } from "../lib/cn.js"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog.js"

export type DiagramLinkTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stage"; readonly id: string }
export interface DiagramLink {
  readonly nodeId: string
  readonly target: DiagramLinkTarget
}

const LINK_DIRECTIVE = /^\s*%%\s*link\s+([\w-]+)\s+(file|stage):(\S+)\s*$/
const STAGE_ID = /^[\w-]+$/

/**
 * `%% link <nodeId> file:<repo path>` / `%% link <nodeId> stage:<id>`. Mermaid
 * treats `%%` as a comment, so linking never needs `securityLevel: "loose"`.
 */
export const parseLinkDirectives = (source: string): ReadonlyArray<DiagramLink> =>
  source.split("\n").flatMap((line): DiagramLink[] => {
    const [, nodeId, kind, value] = LINK_DIRECTIVE.exec(line) ?? []
    if (nodeId === undefined || value === undefined) return []
    if (kind === "stage") return STAGE_ID.test(value) ? [{ nodeId, target: { kind: "stage", id: value } }] : []
    // No path check here: wireLink only links paths resolveOpenablePath finds in
    // the worktree's tracked files, which never contain `..`, `~` or roots.
    return [{ nodeId, target: { kind: "file", path: value } }]
  })

const ZOOM_STEP = 1.25
const clampScale = (scale: number) => Math.min(4, Math.max(0.25, scale))

const iconButton =
  "flex size-6 items-center justify-center rounded border border-line bg-panel text-muted-foreground outline-none hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"

const FLOWCHART_NODE_ID = /-flowchart-([\w-]+)-\d+$/

/**
 * Mermaid's hand-drawn flowchart nodes carry no `data-id`; their DOM id is
 * `<diagram>-flowchart-<nodeId>-<n>`. Other diagram types stamp `data-id`.
 */
const findNode = (root: HTMLElement, nodeId: string): SVGGElement | null =>
  root.querySelector<SVGGElement>(`g[data-id="${nodeId}"]`) ??
  [...root.querySelectorAll<SVGGElement>("g[id]")].find(
    (g) => FLOWCHART_NODE_ID.exec(g.id)?.[1] === nodeId
  ) ??
  null

/** Turn one rendered node into a keyboard-accessible link; null when the node or target is unknown. */
const wireLink = (
  root: HTMLElement,
  { nodeId, target }: DiagramLink,
  openAsset: ReturnType<typeof useOpenAsset>,
  shouldNavigate: () => boolean
): (() => void) | null => {
  const node = findNode(root, nodeId)
  const filePath = target.kind === "file" && openAsset !== null
    ? resolveOpenablePath(target.path, openAsset.knownFiles, openAsset.worktreeRoot)
    : null
  const stage = target.kind === "stage"
    ? root.ownerDocument.querySelector<HTMLElement>(`[data-stage="${target.id}"]`)
    : null
  if (node === null || (filePath === null && stage === null)) return null
  const go = () => {
    if (!shouldNavigate()) return
    if (filePath !== null) openAsset?.open(filePath)
    stage?.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") go()
  }
  node.setAttribute("role", "link")
  node.setAttribute("tabindex", "0")
  node.setAttribute("aria-label", target.kind === "file" ? `Open file ${target.path}` : `Open stage ${target.id}`)
  node.style.cursor = "pointer"
  node.addEventListener("click", go)
  node.addEventListener("keydown", onKey)
  return () => {
    node.removeEventListener("click", go)
    node.removeEventListener("keydown", onKey)
  }
}

function DiagramCanvas({
  svg,
  links,
  className,
  onNavigate,
  onFullscreen
}: {
  svg: string
  links: ReadonlyArray<DiagramLink>
  className?: string
  onNavigate?: () => void
  onFullscreen?: () => void
}) {
  const content = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const openAsset = useOpenAsset()

  // The SVG is injected here, not via dangerouslySetInnerHTML: React may
  // re-apply innerHTML on re-render, which would silently drop the wiring below.
  useEffect(() => {
    const root = content.current
    if (root === null) return
    // mermaid (strict mode) sanitizes this SVG through DOMPurify before it reaches us.
    root.innerHTML = svg
    const cleanups = links.flatMap((link) => {
      const cleanup = wireLink(root, link, openAsset, () => {
        if (dragged.current) return false
        onNavigate?.()
        return true
      })
      return cleanup === null ? [] : [cleanup]
    })
    return () => { for (const cleanup of cleanups) cleanup() }
  }, [svg, links, openAsset, onNavigate])

  const zoom = (factor: number) => setView((current) => ({ ...current, scale: clampScale(current.scale * factor) }))

  return (
    <div className={cn("group relative my-3", className)}>
      <div className="absolute right-1 top-1 z-10 flex gap-1 opacity-60 transition-opacity group-hover:opacity-100">
        <button type="button" aria-label="Zoom in" className={iconButton} onClick={() => zoom(ZOOM_STEP)}><ZoomIn className="size-3.5" /></button>
        <button type="button" aria-label="Zoom out" className={iconButton} onClick={() => zoom(1 / ZOOM_STEP)}><ZoomOut className="size-3.5" /></button>
        <button type="button" aria-label="Reset view" className={iconButton} onClick={() => setView({ scale: 1, x: 0, y: 0 })}><RotateCcw className="size-3.5" /></button>
        {onFullscreen !== undefined && (
          <button type="button" aria-label="Fullscreen" className={iconButton} onClick={onFullscreen}><Maximize2 className="size-3.5" /></button>
        )}
      </div>
      <div
        className="h-full cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, moved: false }
          dragged.current = false
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start === null) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          if (!start.moved && Math.hypot(dx, dy) < 4) return
          // Capture only once it's a real drag: capturing on pointerdown would
          // retarget the click away from linked nodes. Capture keeps the pan
          // alive when the pointer crosses the toolbar or leaves the viewport.
          if (!start.moved) event.currentTarget.setPointerCapture?.(event.pointerId)
          dragged.current = true
          Object.assign(start, { x: event.clientX, y: event.clientY, moved: true })
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
        }}
        onPointerUp={() => { drag.current = null }}
        onPointerCancel={() => { drag.current = null }}
      >
        <div
          ref={content}
          data-testid="mermaid-canvas"
          className="sb-mermaid flex justify-center"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "center top" }}
        />
      </div>
    </div>
  )
}

/**
 * Renders a fenced ```mermaid block as an actual diagram.
 *
 * ## Why this is its own component (not inline in `MarkdownPre`)
 *
 * `mermaid` is heavy (hundreds of KB) and only a small fraction of plans contain
 * a diagram, so it is loaded with a dynamic `import()` INSIDE the effect — it
 * never enters the main renderer bundle and never runs until a diagram is on
 * screen. Rendering is also async (`mermaid.render` returns a promise), which a
 * plain synchronous Streamdown `pre` override cannot express.
 *
 * ## Theming
 *
 * The diagram is themed from the app's live `--sb-*` tokens rather than mermaid's
 * default palette, so it tracks whatever VS Code theme is active. Tokens are read
 * with `getComputedStyle` at render time. If a host has not resolved one yet, the
 * CSS variable reference itself remains the fallback, so diagram colours never
 * introduce a palette outside the existing `--sb-*` contract.
 *
 * ## Safety
 *
 * Plan source is attacker-influenceable (agents write it), so mermaid runs with
 * `securityLevel: "strict"` — it sanitizes labels through DOMPurify and forbids
 * click handlers/inline scripts before we inject the SVG. A malformed diagram
 * rejects rather than throwing up the tree, and we show an inline error card so
 * one bad fence never blanks the rest of the document.
 */

const cssVar = (name: `--sb-${string}`): string => {
  if (typeof document === "undefined") return `var(${name})`
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : `var(${name})`
}

/** Map the app's `--sb-*` tokens onto mermaid's `base` theme variables. */
const themeVariables = (): Record<string, string> => {
  const panel = cssVar("--sb-panel")
  const surface = cssVar("--sb-surface")
  const sunken = cssVar("--sb-sunken")
  const line = cssVar("--sb-line-strong")
  const text = cssVar("--sb-text-body")
  const blue = cssVar("--sb-blue")
  return {
    background: cssVar("--sb-canvas"),
    primaryColor: panel,
    secondaryColor: surface,
    tertiaryColor: sunken,
    primaryBorderColor: line,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    primaryTextColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    lineColor: line,
    textColor: text,
    nodeBorder: line,
    clusterBkg: surface,
    clusterBorder: line,
    titleColor: text,
    edgeLabelBackground: panel,
    actorBorder: line,
    actorBkg: panel,
    labelTextColor: text,
    fontFamily: "inherit",
    fontSize: "13px",
    primaryColorHover: blue
  }
}

function DiagramError({ message }: { message: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-md border border-red/40 bg-red/[0.08]">
      <div className="border-b border-red/30 px-3 py-1.5 text-[11px] font-medium text-red">
        Diagram error
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-text-body">
        {message}
      </pre>
    </div>
  )
}

function DiagramPending() {
  return (
    <div className="my-3 rounded-md border border-line bg-panel px-3 py-4 text-[12px] text-dim">
      Rendering diagram…
    </div>
  )
}

export function MermaidDiagram({ source, className }: { source: string; className?: string }) {
  // `useId` yields ids containing ":" — invalid for the DOM id mermaid uses to
  // stamp its <svg>. Strip everything but word chars.
  const rawId = useId()
  const domId = useMemo(() => `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId])
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const links = useMemo(() => parseLinkDirectives(source), [source])
  const closeFullscreen = useMemo(() => () => setFullscreen(false), [])

  useEffect(() => {
    let cancelled = false
    const trimmed = source.trim()
    if (trimmed.length === 0) {
      setSvg(null)
      setError(null)
      return
    }
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // On a parse error mermaid REJECTS `render` (caught below → our
          // `DiagramError` card) but ALSO injects its "Syntax error in text"
          // bomb SVG straight into `document.body` as a side effect, and never
          // removes it — an orphaned diagram floats at the bottom of the app
          // shell, outside every column. This suppresses that DOM injection;
          // the rejection path is unchanged, so one bad fence still shows the
          // inline card and nothing leaks to the body.
          suppressErrorRendering: true,
          theme: "base",
          look: "handDrawn",
          handDrawnSeed: 1,
          themeVariables: themeVariables()
        })
        // `render` also validates; a syntax error rejects here.
        const result = await mermaid.render(domId, trimmed)
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setSvg(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [domId, source])

  if (error !== null) return <DiagramError message={error} />
  if (svg === null) return <DiagramPending />

  return (
    <>
      <DiagramCanvas svg={svg} links={links} className={className} onFullscreen={() => setFullscreen(true)} />
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="h-[85vh] w-[90vw]">
          <DialogHeader><DialogTitle>Diagram</DialogTitle></DialogHeader>
          <DiagramCanvas svg={svg} links={links} className="my-0 min-h-0 flex-1 p-4" onNavigate={closeFullscreen} />
        </DialogContent>
      </Dialog>
    </>
  )
}
