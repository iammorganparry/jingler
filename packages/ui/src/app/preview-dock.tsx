import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Globe, PanelBottom, PanelRight, RotateCw, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { useResizableWidth } from "../components/resizable.js"
import type { DockSide } from "./terminal-panel.js"

export interface PreviewDockProps {
  /** Fill a session tab instead of sizing and bordering a window-level dock. */
  readonly embedded?: boolean
  readonly dock: DockSide
  readonly onDockChange: (side: DockSide) => void
  readonly visible: boolean
  readonly onToggle: () => void
  readonly url: string
  readonly onNavigate: (url: string) => void
  readonly onReload: () => void
  /** Browser-only body; `active` gates its native Electron overlay. */
  readonly renderBrowser: (active: boolean) => ReactNode
}

const HEIGHT = { key: "jingler.browser.height", initial: 360, min: 180, max: 820 }
const WIDTH = { key: "jingler.browser.width", initial: 520, min: 320, max: 1000 }

/** Internet-only Preview dock. Repository files live in the Files session tab. */
export function PreviewDock(props: PreviewDockProps) {
  const { dock: preferredDock, embedded = false, visible, url } = props
  const { width: shellWidth } = usePaneWidth()
  const dock = effectiveDock(preferredDock, shellWidth)
  const isBottom = dock === "bottom"
  const height = useResizableWidth({
    storageKey: HEIGHT.key,
    initial: HEIGHT.initial,
    min: HEIGHT.min,
    max: HEIGHT.max
  })
  const width = useResizableWidth({
    storageKey: WIDTH.key,
    initial: WIDTH.initial,
    min: WIDTH.min,
    max: WIDTH.max
  })
  const onResize = useCallback(
    (delta: number) => (isBottom ? height.adjust(-delta) : width.adjust(-delta)),
    [height, isBottom, width]
  )
  const [draft, setDraft] = useState(url)
  useEffect(() => setDraft(url), [url])
  const submit = () => {
    const next = draft.trim()
    if (next.length > 0) props.onNavigate(next)
  }

  return (
    <div
      aria-label="Browser preview"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col bg-sunken",
        embedded
          ? "flex-1"
          : cn("flex-none", isBottom ? "border-t border-hairline" : "border-l border-hairline"),
        !visible && "hidden"
      )}
      style={
        visible && !embedded
          ? isBottom
            ? { height: height.width }
            : { width: clampDockWidth(width.width, shellWidth) }
          : undefined
      }
    >
      {!embedded && (
        <DockResizeEdge orientation={isBottom ? "horizontal" : "vertical"} onResize={onResize} />
      )}

      {!embedded && <div className="flex h-9 flex-none items-center border-b border-hairline bg-panel px-2">
        <Globe className="size-3.5 flex-none text-dim" aria-hidden />
        <span className="ml-2 font-mono text-[11.5px] text-text-bright">Browser</span>
        <div className="ml-auto flex items-center gap-0.5">
          <DockSideButton
            side="bottom"
            active={isBottom}
            onClick={() => props.onDockChange("bottom")}
          />
          <DockSideButton
            side="right"
            active={!isBottom}
            onClick={() => props.onDockChange("right")}
          />
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
      </div>}

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
          <Globe className="size-3.5 flex-none text-dim" aria-hidden />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit()
            }}
            spellCheck={false}
            placeholder="http://localhost:3000"
            aria-label="Preview URL"
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[11.5px] text-text-bright outline-none placeholder:text-dim"
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        {props.renderBrowser(visible)}
      </div>
    </div>
  )
}

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

function DockSideButton({
  side,
  active,
  onClick
}: {
  readonly side: DockSide
  readonly active: boolean
  readonly onClick: () => void
}) {
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

function DockResizeEdge({
  orientation,
  onResize
}: {
  readonly orientation: "horizontal" | "vertical"
  readonly onResize: (delta: number) => void
}) {
  const horizontal = orientation === "horizontal"
  const last = useRef(0)
  const dragging = useRef(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return
      const current = horizontal ? event.clientY : event.clientX
      onResize(current - last.current)
      last.current = current
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
      onPointerDown={(event) => {
        event.preventDefault()
        dragging.current = true
        last.current = horizontal ? event.clientY : event.clientX
        setActive(true)
        document.body.style.cursor = horizontal ? "row-resize" : "col-resize"
        document.body.style.userSelect = "none"
      }}
      className={cn(
        "group absolute z-20",
        horizontal
          ? "inset-x-0 top-0 h-px cursor-row-resize"
          : "inset-y-0 left-0 w-px cursor-col-resize"
      )}
    >
      <span
        className={cn(
          "absolute",
          horizontal
            ? "inset-x-0 -top-[3px] -bottom-[3px]"
            : "inset-y-0 -left-[3px] -right-[3px]"
        )}
      />
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
