export type PopoverSide = "top" | "right" | "bottom" | "left"
export type PopoverAlign = "start" | "end"

interface PopoverGeometry {
  readonly trigger: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
  readonly content: { readonly width: number; readonly height: number }
  readonly viewport: { readonly width: number; readonly height: number }
}

const oppositeSide = {
  top: "bottom", bottom: "top", left: "right", right: "left"
} satisfies Record<PopoverSide, PopoverSide>

/** Keep the preferred anchor when it fits; otherwise use the roomier side and scroll. */
export function positionPopover(
  { trigger, content, viewport }: PopoverGeometry,
  preferredSide: PopoverSide,
  align: PopoverAlign,
  gap: number,
  matchTriggerWidth = false
) {
  const padding = 8
  const room = {
    top: Math.max(0, trigger.top - gap - padding),
    bottom: Math.max(0, viewport.height - trigger.top - trigger.height - gap - padding),
    left: Math.max(0, trigger.left - gap - padding),
    right: Math.max(0, viewport.width - trigger.left - trigger.width - gap - padding)
  }
  const requestedWidth = matchTriggerWidth ? trigger.width : content.width
  const vertical = preferredSide === "top" || preferredSide === "bottom"
  const opposite = oppositeSide[preferredSide]
  const extent = vertical ? content.height : requestedWidth
  const side = extent > room[preferredSide] && room[opposite] > room[preferredSide]
    ? opposite
    : preferredSide
  const maxWidth = Math.max(0, Math.min(viewport.width - padding * 2,
    vertical ? viewport.width : room[side]))
  const maxHeight = Math.max(0, Math.min(viewport.height - padding * 2,
    vertical ? room[side] : viewport.height))
  const width = Math.min(requestedWidth, maxWidth)
  const height = Math.min(content.height, maxHeight)
  const left = {
    top: align === "end" ? trigger.left + trigger.width - width : trigger.left,
    bottom: align === "end" ? trigger.left + trigger.width - width : trigger.left,
    left: trigger.left - width - gap,
    right: trigger.left + trigger.width + gap
  }[side]
  const top = {
    top: trigger.top - height - gap,
    bottom: trigger.top + trigger.height + gap,
    left: align === "end" ? trigger.top + trigger.height - height : trigger.top,
    right: align === "end" ? trigger.top + trigger.height - height : trigger.top
  }[side]

  return {
    side,
    left: Math.max(padding, Math.min(left, viewport.width - width - padding)),
    top: Math.max(padding, Math.min(top, viewport.height - height - padding)),
    maxWidth,
    maxHeight,
    width: matchTriggerWidth ? width : undefined
  }
}
