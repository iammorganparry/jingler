import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { PanelBottom, PanelRight, Plus, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { EmptyState } from "../components/feedback.js"
import { StatusDot } from "../components/status-dot.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { useResizableWidth } from "../components/resizable.js"

// ── TerminalDock ──────────────────────────────────────────────────────────────
// The dockable, resizable One-Dark shell around the live terminal cells. This is
// purely presentational: all PTY/tab state lives in the app (useTerminals), and
// each cell is supplied via the `renderTerminal(id)` render-prop (the desktop
// app's XtermView). The dock persists only its own SIZE to localStorage; the
// app owns which side it docks on and whether it's visible.

export type DockSide = "bottom" | "right"
export type TerminalTabStatus = "running" | "idle" | "exited"

export interface TerminalTab {
  id: string
  title: string
  status: TerminalTabStatus
  /** Set once the shell has exited. */
  exitCode?: number | null
}

export interface TerminalDockProps {
  /** Which edge the dock is attached to. */
  dock: DockSide
  onDockChange: (side: DockSide) => void
  /** When false the dock is CSS-hidden (its terminals stay mounted — no respawn). */
  visible: boolean
  /** Hide the dock (the ⌃` / close affordance). */
  onToggle: () => void
  tabs: ReadonlyArray<TerminalTab>
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
  /** Working directory shown in the footer (the session's worktree). */
  cwdLabel?: string
  /** Exit code of the most recently exited shell (null → nothing exited yet). */
  lastExit?: number | null
  /** Render the live terminal cell for a tab id (the desktop app's XtermView). */
  renderTerminal: (id: string) => ReactNode
  /** Fill a session tab instead of drawing dock resize/position controls. */
  embedded?: boolean
}

// Persisted, clamped dock sizes — one per axis so switching sides keeps both.
const HEIGHT = { key: "jingler.terminal.height", initial: 260, min: 140, max: 720 }
const WIDTH = { key: "jingler.terminal.width", initial: 480, min: 300, max: 920 }

/** The dockable terminal shell. Renders every tab's cell (only the active one is
 * shown) so switching tabs — or hiding the dock — never tears down xterm. */
export function TerminalDock(props: TerminalDockProps) {
         function getDockDimensions() {
           return (visible && !embedded
          ? isBottom
            ? { height: height.width }
            : // Capped at a fraction of the row: the stored width is clamped to
              // [300, 920] in absolute pixels, which says nothing about whether
              // it leaves a readable pane beside it.
              { width: clampDockWidth(width.width, shellWidth) }
          : undefined)
         }

  const { dock: preferredDock, tabs, activeId, visible, embedded = false } = props
  // The shell's width (from `app-shell.tsx`), not this dock's own — the question
  // is how much room the ROW has to give away, which a dock measuring itself
  // cannot answer.
  const { width: shellWidth } = usePaneWidth()
  // `props.dock` stays the operator's PREFERENCE; this is where it can fit right
  // now. Widening the window restores the side they actually chose.
  const dock = effectiveDock(preferredDock, shellWidth)
  const isBottom = dock === "bottom"
  // Both hooks always run (stable order); we drive the axis that's docked.
  // Drags paint the dock's size straight onto the element — every terminal
  // stays mounted in here, and a setState per pointermove re-rendered (and
  // re-fit) all of them sixty times a second. State commits on release.
  const dockEl = useRef<HTMLDivElement | null>(null)
  const shellWidthRef = useRef(shellWidth)
  shellWidthRef.current = shellWidth
  const height = useResizableWidth({
    storageKey: HEIGHT.key,
    initial: HEIGHT.initial,
    min: HEIGHT.min,
    max: HEIGHT.max,
    applyLive: (value) => {
      const el = dockEl.current
      if (el) el.style.height = `${value}px`
    }
  })
  const width = useResizableWidth({
    storageKey: WIDTH.key,
    initial: WIDTH.initial,
    min: WIDTH.min,
    max: WIDTH.max,
    applyLive: (value) => {
      const el = dockEl.current
      // The same shell-relative cap the committed render applies below.
      if (el) el.style.width = `${clampDockWidth(value, shellWidthRef.current)}px`
    }
  })

  // Dragging the edge toward the content (up / left) GROWS the dock → invert.
  const onResize = useCallback(
    (delta: number) => (isBottom ? height.adjust(-delta) : width.adjust(-delta)),
    [isBottom, height, width]
  )
  const onResizeEnd = useCallback(
    () => (isBottom ? height.commit() : width.commit()),
    [isBottom, height, width]
  )

  return (
    <div
      ref={dockEl}
      className={cn(
        "relative flex flex-col bg-sunken",
        embedded ? "min-h-0 min-w-0 flex-1" : "flex-none",
        !embedded && (isBottom ? "border-t border-hairline" : "border-l border-hairline"),
        !visible && "hidden"
      )}
      style={
        getDockDimensions()
      }
    >
      {!embedded && (
        <DockResizeEdge
          orientation={isBottom ? "horizontal" : "vertical"}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}

      {/* Tab strip */}
      <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel pr-1.5">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onSelect={() => props.onSelect(t.id)}
              onClose={() => props.onClose(t.id)}
            />
          ))}
          <button
            type="button"
            onClick={props.onNew}
            aria-label="New terminal"
            className="flex flex-none items-center px-2.5 text-dim transition-colors hover:text-text-bright"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {!embedded && (
          <div className="flex flex-none items-center gap-0.5 pl-1.5">
            <DockSideButton side="bottom" active={isBottom} onClick={() => props.onDockChange("bottom")} />
            <DockSideButton side="right" active={!isBottom} onClick={() => props.onDockChange("right")} />
            <button
              type="button"
              onClick={props.onToggle}
              aria-label="Hide terminal"
              title="Hide terminal (⌃`)"
              className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Body — every terminal stays mounted; only the active one is shown. */}
      <div className="relative min-h-0 flex-1 bg-sunken">
        {tabs.length === 0 ? (
          <EmptyDock onNew={props.onNew} />
        ) : (
          tabs.map((t) => (
            <div key={t.id} className={cn("absolute inset-0", t.id === activeId ? "block" : "hidden")}>
              {props.renderTerminal(t.id)}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex h-7 flex-none items-center gap-2.5 border-t border-hairline bg-panel px-3 font-mono text-[10.5px] text-dim">
        {props.cwdLabel && (
          <>
            <span className="min-w-0 truncate text-muted-foreground">{props.cwdLabel}</span>
            <span className="flex-none text-line">·</span>
          </>
        )}
        {props.lastExit != null && (
          <span className="flex-none">
            last exit <span className={props.lastExit === 0 ? "text-green" : "text-red"}>{props.lastExit}</span>
          </span>
        )}
        <div className="flex-1" />
        {!embedded && <span className="flex-none">⌃` toggle</span>}
      </div>
    </div>
  )
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: TerminalTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex flex-none cursor-pointer items-center gap-2 border-r border-hairline px-3 font-mono text-[11.5px]",
        active
          ? "border-t-2 border-t-blue bg-sunken text-text-bright"
          : "text-muted-foreground opacity-70 hover:opacity-100"
      )}
    >
      <span
        className={cn(
          "size-1.5 flex-none rounded-full",
          tab.status === "running" ? "bg-green" : tab.status === "exited" ? "bg-red" : "bg-line-strong"
        )}
      />
      <span className="max-w-[140px] truncate">{tab.title}</span>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="ml-0.5 flex size-4 flex-none items-center justify-center rounded text-dim opacity-0 transition hover:bg-hairline hover:text-text-bright group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
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

function EmptyDock({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-2 rounded-md border border-hairline bg-panel px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-text-bright"
      >
        <Plus className="size-3.5" /> New terminal
      </button>
    </div>
  )
}

/**
 * A drag edge that resizes the dock: a horizontal bar along the top for a bottom
 * dock, a vertical bar along the left for a right dock. Reports per-move pixel
 * deltas (mirrors the ResizeHandle in components/resizable but axis-aware).
 */
function DockResizeEdge({
  orientation,
  onResize,
  onResizeEnd
}: {
  orientation: "horizontal" | "vertical"
  onResize: (delta: number) => void
  /** Drag released — commit the live size to state/storage. */
  onResizeEnd?: () => void
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
      onResizeEnd?.()
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [horizontal, onResize, onResizeEnd])

  return (
    <div
      role="separator"
      aria-label="Resize terminal"
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
      {/* Wide invisible hit area for an easy grab. */}
      <span
        className={cn("absolute", horizontal ? "inset-x-0 -top-[3px] -bottom-[3px]" : "inset-y-0 -left-[3px] -right-[3px]")}
      />
      {/* The visible hairline, highlighted while hovered / dragging. */}
      <span
        className={cn(
          "absolute bg-hairline transition-colors group-hover:bg-line-strong",
          horizontal ? "inset-x-0 top-0 h-px" : "inset-y-0 left-0 w-px",
          active && "bg-line-strong"
        )}
      />
    </div>
  )
}

// ── TerminalPanel ─────────────────────────────────────────────────────────────
// The Terminal view's content: a tab strip, the live shells, and a footer, in a
// panel anchored to the bottom of the view. Its height is drag-resizable and
// remembered per workspace (session id).

const PANEL_HEIGHT = { initial: 240, min: 120, max: 720 }

/** localStorage key holding one workspace's terminal panel height. */
export const terminalPanelHeightKey = (sessionId: string): string =>
  `jingler.terminal.panel-height.${sessionId}`

export interface TerminalPanelProps {
  /** Scopes the persisted height. Remount (`key`) when it changes. */
  sessionId: string
  /** When false the panel is CSS-hidden (its shells stay mounted — no respawn). */
  visible?: boolean
  tabs: ReadonlyArray<TerminalTab>
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
  /** Replace an exited shell with a fresh one. */
  onRestart: (id: string) => void
  /** Working directory shown in the footer (the session's worktree). */
  cwdLabel?: string
  /** Exit code of the most recently exited shell (null → nothing exited yet). */
  lastExit?: number | null
  /** Render the live terminal cell for a tab id (the desktop app's XtermView). */
  renderTerminal: (id: string) => ReactNode
}

/** Bottom terminal panel: resizable, tabbed, with empty and exited states. */
export function TerminalPanel(props: TerminalPanelProps) {
  const { sessionId, visible = true } = props
  const panelEl = useRef<HTMLElement | null>(null)
  // Drags paint straight onto the element; state + storage commit on release.
  const { width: height, adjust, commit } = useResizableWidth({
    storageKey: terminalPanelHeightKey(sessionId),
    ...PANEL_HEIGHT,
    applyLive: (value) => {
      if (panelEl.current) panelEl.current.style.height = `${value}px`
    }
  })
  // Dragging the edge up grows the panel → invert.
  const onResize = useCallback((delta: number) => adjust(-delta), [adjust])

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col justify-end bg-sunken", !visible && "hidden")}>
      <section
        ref={panelEl}
        data-testid="terminal-panel"
        aria-label="Terminal"
        className="relative flex max-h-full flex-none flex-col border-t border-hairline bg-sunken"
        style={{ height }}
      >
        <DockResizeEdge orientation="horizontal" onResize={onResize} onResizeEnd={commit} />
        <TerminalTabStrip {...props} />
        <TerminalBody {...props} />
        <TerminalFooter cwdLabel={props.cwdLabel} lastExit={props.lastExit} />
      </section>
    </div>
  )
}

const dotTone = (tab: TerminalTab): string => {
  if (tab.status === "running") return "bg-text-bright"
  if (tab.status === "exited") return tab.exitCode ? "bg-state-failed" : "bg-line-strong"
  return "bg-dim"
}

function TerminalTabStrip({
  tabs,
  activeId,
  onSelect,
  onNew,
  onClose
}: Pick<TerminalPanelProps, "tabs" | "activeId" | "onSelect" | "onNew" | "onClose">) {
  return (
    <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel">
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group flex flex-none items-center border-r border-hairline",
              tab.id === activeId
                ? "border-b-2 border-b-text-bright bg-sunken text-text-bright"
                : "text-muted-foreground opacity-70 hover:opacity-100"
            )}
          >
            <Button
              role="tab"
              aria-selected={tab.id === activeId}
              variant="ghost"
              size="sm"
              onClick={() => onSelect(tab.id)}
              className="h-full gap-2 rounded-none px-3 font-mono text-[11.5px]"
            >
              <StatusDot tone={dotTone(tab)} size={6} />
              <span className="max-w-[140px] truncate">{tab.title}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab.id)}
              className="mr-1 size-5 flex-none opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="New terminal"
        onClick={onNew}
        className="h-full w-9 flex-none rounded-none"
      >
        <Plus className="size-3.5" />
      </Button>
    </div>
  )
}

function TerminalBody({
  tabs,
  activeId,
  onNew,
  onRestart,
  renderTerminal
}: Pick<TerminalPanelProps, "tabs" | "activeId" | "onNew" | "onRestart" | "renderTerminal">) {
  if (tabs.length === 0) {
    return (
      <div data-testid="terminal-empty" className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          title="No terminals"
          description="Start a shell in this workspace's worktree."
          action={
            <Button variant="secondary" size="sm" onClick={onNew}>
              <Plus className="size-3.5" /> New terminal
            </Button>
          }
        />
      </div>
    )
  }
  const exited = tabs.find((tab) => tab.id === activeId && tab.status === "exited")
  // Every shell stays mounted; only the active one is shown.
  return (
    <div className="relative min-h-0 flex-1 bg-sunken">
      {exited && (
        <div
          data-testid="terminal-exited"
          className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-hairline bg-panel px-3 py-1.5 text-[12px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            Shell exited{exited.exitCode != null ? ` with code ${exited.exitCode}` : ""}
          </span>
          <Button variant="secondary" size="sm" onClick={() => onRestart(exited.id)}>
            Restart
          </Button>
        </div>
      )}
      {tabs.map((tab) => (
        <div key={tab.id} className={cn("absolute inset-0", tab.id === activeId ? "block" : "hidden")}>
          {renderTerminal(tab.id)}
        </div>
      ))}
    </div>
  )
}

function TerminalFooter({ cwdLabel, lastExit }: Pick<TerminalPanelProps, "cwdLabel" | "lastExit">) {
  return (
    <div className="flex h-7 flex-none items-center gap-2.5 border-t border-hairline bg-panel px-3 font-mono text-[10.5px] text-dim">
      {cwdLabel && <span className="min-w-0 truncate text-muted-foreground">{cwdLabel}</span>}
      {cwdLabel && lastExit != null && <span className="flex-none text-line">·</span>}
      {lastExit != null && (
        <span className="flex-none">
          last exit <span className={lastExit === 0 ? "text-text-bright" : "text-state-failed"}>{lastExit}</span>
        </span>
      )}
    </div>
  )
}
