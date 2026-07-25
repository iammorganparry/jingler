import { cn } from "../lib/cn.js"

/**
 * Cell-service signal bars — `level` of `total` filled, ascending left to right.
 *
 * Used for reasoning strength, where the value is a rung on a provider's own
 * ladder rather than a thing with an icon of its own. A brain glyph said
 * "thinking" and nothing about how much; bars carry the magnitude at a glance,
 * borrowing a scale every phone has already taught the operator to read.
 *
 * The unfilled bars are drawn, not omitted — the ceiling is the information.
 * Two filled bars means nothing without the three empty ones beside them.
 */
export function SignalBars({
  level,
  total = 5,
  size = 13,
  slashed = false,
  className
}: {
  /** Bars to fill, 0…`total`. Zero renders the whole ramp dim ("unset"). */
  level: number
  total?: number
  size?: number
  /** Struck through — the phone idiom for "off", not merely "lowest". */
  slashed?: boolean
  className?: string
}) {
  // Laid out on a 14×14 grid so bar+gap divides evenly at the default total:
  // 5 bars of 2 with 1 between them is exactly 14 wide, and the viewBox does
  // the scaling to whatever `size` the call site asks for.
  const gap = 1
  const width = (14 - gap * (total - 1)) / total
  const shortest = 3
  const step = (12 - shortest) / Math.max(total - 1, 1)

  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("flex-none", className)}
    >
      {Array.from({ length: total }, (_, i) => {
        const height = shortest + step * i
        return (
          <rect
            key={i}
            x={i * (width + gap)}
            y={13 - height}
            width={width}
            height={height}
            rx={0.5}
            fill="currentColor"
            // Dim rather than absent: an empty rung still has to read as a rung.
            opacity={i < level ? 1 : 0.24}
          />
        )
      })}
      {slashed && (
        <line
          x1={1}
          y1={13}
          x2={13}
          y2={1}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
