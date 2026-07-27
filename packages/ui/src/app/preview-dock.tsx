import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Globe, PanelBottom, PanelRight, RotateCw, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { useResizableWidth } from "../components/resizable.js"
import { FileIcon } from "../components/file-icon.js"
import type { DockSide } from "./terminal-panel.js"

// ── PreviewDock ───────────────────────────────────────────────────────────────
// The dockable, resizable shell for everything you LOOK at rather than talk to:
// the embedded browser, and the assets an agent leaves in its worktree (a
// markdown report, a chart, a CSV, a PDF).
//
// One dock with tabs rather than two docks, because the alternative is two
// panels competing for the same edge of the same window — open both and each is
// too small to read. The Browser tab is pinned and always first, so the dock has
// a stable identity even with no assets open.
//
// Purely presentational: the app owns visibility, dock side, which tabs exist,
// and what a tab's body is (via `renderTab`). The dock owns only its own size.

export type PreviewTabKind = "browser" | "asset"

export interface PreviewTab {
  id: string
  kind: PreviewTabKind
  /** Shown on the tab. For an asset this is the basename, not the full path. */
  title: string
  /** Worktree-relative path — drives the file glyph and the tab's tooltip. */
  path?: string
}

export interface PreviewDockProps {
  /** Which edge the dock is attached to. */
  dock: DockSide
  onDockChange: (side: DockSide) => void
  /** When false the dock is CSS-hidden. Bodies stay mounted — see `renderTab`. */
  visible: boolean
  /** Hide the dock. */
  onToggle: () => void
  /** Tabs, in display order. The pinned browser tab is expected first. */
  tabs: ReadonlyArray<PreviewTab>
  activeId: string
  onSelect: (id: string) => void
  /** Close an asset tab. Never called for the pinned browser tab. */
  onClose: (id: string) => void
  /** The currently-loaded browser URL (seeds the address bar). */
  url: string
  /** Load a URL (Enter). The app validates + drives the native view. */
  onNavigate: (url: string) => void
  /** Reload the browser tab's page. */
  onReload: () => void
  /**
   * A tab's body. Called for EVERY tab on every render, not just the active
   * one, and the results are all mounted with the inactive ones CSS-hidden.
   *
   * That is load-bearing for the browser: its body is a bounds-measured
   * placeholder for a native `WebContentsView` whose page, history and scroll
   * position live in the main process. Unmounting it to show an asset would
   * destroy the view, and clicking back to Browser would land on a blank
   * default URL. `active` is passed so a body that drives something outside the
   * DOM can suspend itself instead of unmounting.
   */
  renderTab: (tab: PreviewTab, active: boolean) => ReactNode
}

// Persisted, clamped dock sizes — one per axis so switching sides keeps both.
// The keys are the browser preview's originals on purpose: this dock replaced
// it in place, and renaming them would silently reset every existing install's
// carefully-dragged height to the default.
const HEIGHT = { key: "jingler.browser.height", initial: 360, min: 180, max: 820 }
const WIDTH = { key: "jingler.browser.width", initial: 520, min: 320, max: 1000 }

/** The id of the pinned browser tab. Stable, so the app can address it directly. */
export const BROWSER_TAB_ID = "browser"

/** The dockable preview shell (tab strip, optional URL bar, tab bodies). */
export function PreviewDock(props: PreviewDockProps) {
  const { dock: preferredDock, tabs, activeId, visible, url } = props
  // The shell's width (from `app-shell.tsx`), not this dock's own — the question
  // is how much room the ROW has to give away, which a dock measuring itself
  // cannot answer.
  const { width: shellWidth } = usePaneWidth()
  // `props.dock` stays the operator's PREFERENCE; this is where it can fit right
  // now. Widening the window restores the side they actually chose.
  const dock = effectiveDock(preferredDock, shellWidth)
  const isBottom = dock === "bottom"
  const height = useResizableWidth({ storageKey: HEIGHT.key, initial: HEIGHT.initial, min: HEIGHT.min, max: HEIGHT.max })
  const width = useResizableWidth({ storageKey: WIDTH.key, initial: WIDTH.initial, min: WIDTH.min, max: WIDTH.max })

  // Dragging the edge toward the content (up / left) GROWS the dock → invert.
  const onResize = useCallback(
    (delta: number) => (isBottom ? height.adjust(-delta) : width.adjust(-delta)),
    [isBottom, height, width]
  )

  // Local address-bar text, seeded from the loaded URL and re-synced when it
  // changes underneath us (e.g. app seeds the session's dev-server port).
  const [draft, setDraft] = useState(url)
  useEffect(() => setDraft(url), [url])

  const submit = () => {
    const next = draft.trim()
    if (next) props.onNavigate(next)
  }

  const browsing = tabs.find((t) => t.id === activeId)?.kind === "browser"

  return (
    <div
      className={cn(
        "relative flex flex-none flex-col bg-sunken",
        isBottom ? "border-t border-hairline" : "border-l border-hairline",
        !visible && "hidden"
      )}
      style={
        visible
          ? isBottom
            ? { height: height.width }
            : // Capped at a fraction of the row: the stored width is clamped to
              // [320, 1000] in absolute pixels, which says nothing about whether
              // it leaves a readable pane beside it.
              { width: clampDockWidth(width.width, shellWidth) }
          : undefined
      }
    >
      <DockResizeEdge orientation={isBottom ? "horizontal" : "vertical"} onResize={onResize} />

      {/* Tab strip */}
      <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel pr-1.5">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => (
            <PreviewTabButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onSelect={() => props.onSelect(t.id)}
              // The browser tab is the dock's identity — closing it would leave
              // a chrome-less panel with nothing to go back to.
              onClose={t.kind === "browser" ? undefined : () => props.onClose(t.id)}
            />
          ))}
        </div>
        <div className="flex flex-none items-center gap-0.5 pl-1.5">
          <DockSideButton side="bottom" active={isBottom} onClick={() => props.onDockChange("bottom")} />
          <DockSideButton side="right" active={!isBottom} onClick={() => props.onDockChange("right")} />
          <button
            type="button"
            onClick={props.onToggle}
            aria-label="Hide preview"
            title="Hide preview (⌃⇧B)"
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/*
        Address bar — browser tab only. An asset has a path, not a URL, and
        leaving an editable localhost field above a rendered markdown file
        invites typing into it and wondering why nothing happened.
      */}
      {browsing && (
        <div className="flex h-9 flex-none items-center gap-1.5 border-b border-hairline bg-panel px-2">
          <button
            type="button"
            onClick={props.onReload}
            aria-label="Reload"
            title="Reload"
            className="flex size-6 flex-none items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <RotateCw className="size-3.5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-hairline bg-sunken px-2">
            <Globe className="size-3.5 flex-none text-dim" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
              spellCheck={false}
              placeholder="http://localhost:3000"
              aria-label="Preview URL"
              className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[11.5px] text-text-bright outline-none placeholder:text-dim"
            />
          </div>
        </div>
      )}

      {/* Bodies — every tab stays mounted; only the active one is shown. */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              className={cn(
                "absolute inset-0",
                active ? "block" : "hidden",
                // The browser renders somebody ELSE'S page over these bounds, so
                // it gets the CSS default a bare document would have. Tinting it
                // with a Jingler surface would restyle a stranger's site — and
                // on a light theme, hide it entirely.
                t.kind === "browser" ? "bg-white" : "bg-canvas"
              )}
            >
              {props.renderTab(t, active)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PreviewTabButton({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: PreviewTab
  active: boolean
  onSelect: () => void
  /** Omitted for a pinned tab, which then renders no ✕ at all. */
  onClose?: () => void
}) {
  // A real <button> for the tab, not a div+onClick: a div is invisible to the
  // a11y tree and unreachable by keyboard, which is how this shipped. The close
  // ✕ is a SIBLING button, not nested — a button inside a button is invalid HTML
  // the browser reparents. The active/inactive treatment and hover-reveal live on
  // the wrapper so both look identical to the old single element.
  return (
    <div
      className={cn(
        "group flex flex-none items-stretch border-r border-hairline font-mono text-[11.5px]",
        active
          ? "border-t-2 border-t-blue bg-sunken text-text-bright"
          : "text-muted-foreground opacity-70 hover:opacity-100"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={tab.path ?? tab.title}
        className={cn("flex min-w-0 cursor-pointer items-center gap-2 pl-3", onClose ? "pr-1.5" : "pr-3")}
      >
        {tab.kind === "browser" ? (
          <Globe className="size-3 flex-none text-dim" aria-hidden />
        ) : (
          <FileIcon path={tab.path ?? tab.title} size={12} />
        )}
        <span className="max-w-[140px] truncate">{tab.title}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onClick={onClose}
          className="mr-1.5 flex size-4 flex-none items-center justify-center self-center rounded text-dim opacity-0 transition hover:bg-hairline hover:text-text-bright group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

/**
 * The dock's toggle, for the window title bar.
 *
 * It lives there rather than in a pane's tab bar because the dock is app-level:
 * one dock, one native browser view, shared by every pane. A copy of the control
 * in each pane's chrome implied otherwise — four toggles that all drove the same
 * thing, and no obvious answer to which pane's browser you were looking at.
 */
export function PreviewToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Preview"
      aria-pressed={active}
      data-testid="toggle-browser"
      title="Toggle preview (⌃⇧B)"
      className={cn(
        "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
        active ? "text-blue" : "text-dim hover:text-text-bright"
      )}
    >
      <Globe className="size-4" />
    </button>
  )
}

function DockSideButton({ side, active, onClick }: { side: DockSide; active: boolean; onClick: () => void }) {
  const Icon = side === "bottom" ? PanelBottom : PanelRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Dock ${side}`}
      aria-pressed={active}
      className={cn(
        "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
        active ? "text-blue" : "text-dim hover:text-text-bright"
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

/**
 * A drag edge that resizes the dock (mirrors the terminal dock's edge): a
 * horizontal bar along the top for a bottom dock, a vertical bar along the left
 * for a right dock. Reports per-move pixel deltas.
 */
function DockResizeEdge({
  orientation,
  onResize
}: {
  orientation: "horizontal" | "vertical"
  onResize: (delta: number) => void
}) {
  const horizontal = orientation === "horizontal"
  const last = useRef(0)
  const dragging = useRef(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      const cur = horizontal ? e.clientY : e.clientX
      onResize(cur - last.current)
      last.current = cur
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [horizontal, onResize])

  return (
    <div
      role="separator"
      aria-label="Resize preview"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        last.current = horizontal ? e.clientY : e.clientX
        setActive(true)
        document.body.style.cursor = horizontal ? "row-resize" : "col-resize"
        document.body.style.userSelect = "none"
      }}
      className={cn(
        "group absolute z-20",
        horizontal ? "inset-x-0 top-0 h-px cursor-row-resize" : "inset-y-0 left-0 w-px cursor-col-resize"
      )}
    >
      <span className={cn("absolute", horizontal ? "inset-x-0 -top-[3px] -bottom-[3px]" : "inset-y-0 -left-[3px] -right-[3px]")} />
      <span
        className={cn(
          "absolute bg-hairline transition-colors group-hover:bg-blue",
          horizontal ? "inset-x-0 top-0 h-px" : "inset-y-0 left-0 w-px",
          active && "bg-blue"
        )}
      />
    </div>
  )
}
