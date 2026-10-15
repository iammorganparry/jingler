import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  PanelBottom,
  PanelRight,
  RotateCw,
  Smartphone,
  Tablet,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { clampDockWidth, effectiveDock } from "./dock-fit.js"
import { Button } from "../components/button.js"
import { InlineError } from "../components/feedback.js"
import { IconButtonGroup } from "../components/icon-button-group.js"
import { Input } from "../components/input.js"
import { Tooltip } from "../components/tooltip.js"
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
  /** Back/forward are disabled while the page has no history in that direction. */
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly onBack: () => void
  readonly onForward: () => void
  readonly onOpenExternal: () => void
  /** The page is loading: the reload icon spins. */
  readonly loading?: boolean
  /** Last main-frame load failure; shows an error row with Retry (reload). */
  readonly error?: string | null
  /** Browser-only body; `active` gates its native Electron overlay. */
  readonly renderBrowser: (active: boolean) => ReactNode
}

const HEIGHT = { key: "jingler.browser.height", initial: 360, min: 180, max: 820 }
const WIDTH = { key: "jingler.browser.width", initial: 520, min: 320, max: 1000 }

const DEVICES = [
  { id: "phone", label: "Phone", Icon: Smartphone, px: 390 },
  { id: "tablet", label: "Tablet", Icon: Tablet, px: 768 },
  { id: "desktop", label: "Desktop", Icon: Monitor, px: null }
] as const
type DeviceId = (typeof DEVICES)[number]["id"]

/** Internet-only Preview dock. Repository files live in the Files session tab. */
export function PreviewDock(props: PreviewDockProps) {
  const { dock: preferredDock, embedded = false, visible } = props
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
  const [device, setDevice] = useState<DeviceId>("desktop")
  const devicePx = DEVICES.find((entry) => entry.id === device)?.px ?? null
  const size = isBottom ? { height: height.width } : { width: clampDockWidth(width.width, shellWidth) }

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
      style={visible && !embedded ? size : undefined}
    >
      {!embedded && (
        <DockResizeEdge orientation={isBottom ? "horizontal" : "vertical"} onResize={onResize} />
      )}
      {!embedded && <DockHeader isBottom={isBottom} onDockChange={props.onDockChange} onToggle={props.onToggle} />}
      <PreviewToolbar {...props} device={device} onDeviceChange={setDevice} />
      {props.error ? (
        <InlineError message={props.error} onRetry={props.onReload} className="mx-2 my-1.5 flex-none" />
      ) : null}
      <div className="relative min-h-0 flex-1 bg-sunken">
        <div
          className="relative mx-auto h-full bg-white"
          style={devicePx === null ? undefined : { width: devicePx, maxWidth: "100%" }}
        >
          {props.renderBrowser(visible)}
        </div>
      </div>
    </div>
  )
}

function DockHeader({
  isBottom,
  onDockChange,
  onToggle
}: {
  readonly isBottom: boolean
  readonly onDockChange: (side: DockSide) => void
  readonly onToggle: () => void
}) {
  return (
    <div className="flex h-9 flex-none items-center border-b border-hairline bg-panel px-2">
      <Globe className="size-3.5 flex-none text-dim" aria-hidden />
      <span className="ml-2 font-mono text-[11.5px] text-text-bright">Browser</span>
      <div className="ml-auto flex items-center gap-0.5">
        <DockSideButton side="bottom" active={isBottom} onClick={() => onDockChange("bottom")} />
        <DockSideButton side="right" active={!isBottom} onClick={() => onDockChange("right")} />
        <Tooltip label="Hide preview" shortcut="mod+shift+b">
          <Button variant="ghost" size="icon" className="size-6" onClick={onToggle} aria-label="Hide preview">
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

/** Board 21 toolbar: navigation group, address field, device-width group. */
function PreviewToolbar({
  url,
  loading = false,
  canGoBack,
  canGoForward,
  device,
  onNavigate,
  onReload,
  onBack,
  onForward,
  onOpenExternal,
  onDeviceChange
}: PreviewDockProps & { readonly device: DeviceId; readonly onDeviceChange: (device: DeviceId) => void }) {
  const [draft, setDraft] = useState(url)
  useEffect(() => setDraft(url), [url])
  const submit = () => {
    const next = draft.trim()
    if (next.length > 0) onNavigate(next)
  }
  return (
    <div aria-busy={loading} className="flex h-9 flex-none items-center gap-2 border-b border-hairline bg-panel px-2">
      <IconButtonGroup
        label="Browser navigation"
        items={[
          { id: "back", label: "Back", icon: <ArrowLeft size={16} />, onClick: onBack, disabled: !canGoBack },
          { id: "forward", label: "Forward", icon: <ArrowRight size={16} />, onClick: onForward, disabled: !canGoForward },
          { id: "reload", label: "Reload", icon: <RotateCw size={16} className={cn(loading && "animate-spin")} />, onClick: onReload },
          { id: "external", label: "Open in external browser", icon: <ExternalLink size={16} />, onClick: onOpenExternal }
        ]}
      />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit()
        }}
        spellCheck={false}
        placeholder="http://localhost:3000"
        aria-label="Preview URL"
        className="h-7 min-w-0 flex-1 rounded-md border-hairline bg-sunken px-2 font-mono text-[11.5px] leading-none"
      />
      <IconButtonGroup
        label="Device width"
        items={DEVICES.map(({ id, label, Icon }) => ({
          id,
          label,
          icon: <Icon size={16} />,
          pressed: id === device,
          onClick: () => onDeviceChange(id)
        }))}
      />
    </div>
  )
}

export function PreviewToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <Tooltip label="Toggle preview" shortcut="mod+shift+b">
      <Button
        variant="ghost"
        size="icon"
        onClick={onClick}
        aria-label="Preview"
        aria-pressed={active}
        data-testid="toggle-browser"
        className={cn("size-6", active && "text-blue")}
      >
        <Globe className="size-4" />
      </Button>
    </Tooltip>
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
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={`Dock ${side}`}
      aria-pressed={active}
      className={cn("size-6", active && "text-blue")}
    >
      <Icon className="size-3.5" />
    </Button>
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
