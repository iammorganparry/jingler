import type { CSSProperties, ReactNode } from "react"
import { JinglerMark } from "../brand/jingler-mark.js"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/** macOS-style window title bar with traffic lights and a centered brand mark + title. */
export function TitleBar({
  title = "Jingler",
  actions
}: {
  title?: string
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
        The title is absolutely centred rather than flexed between the two side
        blocks. Those blocks are different widths — traffic lights on the left,
        a five-button layout picker on the right — so a `flex-1` title would sit
        visibly off-centre in the only configuration the app actually renders.
      */}
      {/*
        Mark and title travel together, centred as one unit.

        The mark is INSIDE the absolutely-centred block rather than pinned beside
        the traffic lights, because the left block is the one place it cannot go:
        macOS reserves that corner, and on Windows/Linux the same slot is where
        the window's own icon lands. Centred, it reads as the app's mark on every
        platform and never collides with system chrome.
      */}
      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5 text-[12px] text-dim">
        {/*
          `text-brand` rather than inheriting `text-dim`: the mark is the one
          spot of colour in an otherwise monochrome bar, and a grey logo reads
          as a disabled control. It stays quiet by being 13px, not by being
          desaturated.
        */}
        <JinglerMark className="h-[13px] w-auto text-brand" />
        {title}
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
