import type { CSSProperties, ReactNode } from "react"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/** Window chrome plus the focused session's global tab row. */
export function TitleBar({
  title = "Jingler",
  actions
}: {
  title?: string
  actions?: ReactNode
}) {
  return (
    <div
      data-testid="title-bar"
      title={title}
      style={drag}
      className="flex h-11 flex-none items-center gap-2 border-b border-hairline bg-panel px-3.5"
    >
      <div
        id="session-tab-bar-portal"
        style={noDrag}
        className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
      />
      {actions ? (
        <div style={noDrag} className="relative flex flex-none justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
