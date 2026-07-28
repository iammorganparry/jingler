import type { CSSProperties, ReactNode } from "react"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/**
 * macOS-style window title bar: traffic lights on the left, a centred slot (the
 * global search) in the middle, and app actions on the right.
 */
export function TitleBar({
  center,
  actions
}: {
  /**
   * The centre slot — the global-search field. Absolutely centred rather than
   * flexed, because the two side blocks are different widths (traffic lights vs.
   * actions) and a flexed centre would sit visibly off-axis.
   */
  center?: ReactNode
  /**
   * Controls pinned to the right edge. Marked `no-drag`, or a click on one would
   * be swallowed by the window's drag region instead of reaching the button.
   */
  actions?: ReactNode
}) {
  return (
    <div
      style={drag}
      className="relative flex h-[38px] flex-none items-center gap-3.5 border-b border-hairline bg-panel px-3.5"
    >
      {/*
        The centre is absolutely positioned so it ignores the uneven side blocks.
        The wrapper is `pointer-events-none` so the empty bar beside the field
        stays a drag handle; the field itself re-enables pointer events and is
        `no-drag` so it can be clicked and typed into.
      */}
      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center">
        <div style={noDrag} className="pointer-events-auto">
          {center}
        </div>
      </div>
      {/*
        Literal hexes on purpose: these are macOS's own traffic-light colours,
        which stay put across every theme (and across macOS's own light/dark
        switch). Tokenising them would make the window controls stop reading as
        window controls.
      */}
      <div style={noDrag} className="relative flex gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex-1" />
      <div style={noDrag} className="relative flex justify-end">
        {actions}
      </div>
    </div>
  )
}
