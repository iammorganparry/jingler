import type { CSSProperties, ReactNode } from "react"
import { WindowControls } from "./window-controls.js"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/** Window chrome plus the focused session's global tab row. */
export function TitleBar({
  title = "Jingler",
  actions,
  platform,
  windowControls
}: {
  title?: string
  actions?: ReactNode
  /** `process.platform`. Window controls draw only when this is set and is not `darwin`. */
  platform?: string
  windowControls?: Parameters<typeof WindowControls>[0]
}) {
  const overlay = platform !== undefined && platform !== "darwin"
  return (
    <div
      data-testid="title-bar"
      title={title}
      style={drag}
      className="window-drag-region flex h-11 flex-none items-center gap-2 border-b border-hairline bg-panel px-3.5"
    >
      {overlay ? null : <div aria-hidden className="w-11 flex-none" />}
      <div id="session-header-identity-portal" style={noDrag} className="flex min-w-0 flex-none items-center" />
      <div
        id="session-tab-bar-portal"
        className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
      />
      <div id="session-header-views-portal" style={noDrag} className="flex flex-none items-center" />
      {actions ? (
        <div style={noDrag} className="relative flex flex-none justify-end">
          {actions}
        </div>
      ) : null}
      {overlay ? <WindowControls {...windowControls} /> : null}
    </div>
  )
}
