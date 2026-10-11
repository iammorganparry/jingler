import type { CSSProperties } from "react"
import { Minus, Square, Copy, X } from "lucide-react"
import { Button } from "../components/button.js"

const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/**
 * Minimise / maximise-restore / close for Windows and Linux (the macOS traffic lights stay native).
 * Hover is neutral; only Close turns red (spec §6.10).
 */
export function WindowControls({
  maximized = false,
  onMinimize,
  onToggleMaximize,
  onClose
}: {
  maximized?: boolean
  onMinimize?: () => void
  onToggleMaximize?: () => void
  onClose?: () => void
}) {
  const base = "h-full w-[46px] rounded-none"
  return (
    <div data-testid="window-controls" style={noDrag} className="-mr-3.5 flex h-full flex-none items-stretch">
      <Button variant="ghost" size="icon" aria-label="Minimize" onClick={onMinimize} className={base}>
        <Minus size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={onToggleMaximize}
        className={base}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close"
        onClick={onClose}
        className={`${base} hover:bg-state-failed hover:text-primary-fg`}
      >
        <X size={14} />
      </Button>
    </div>
  )
}
