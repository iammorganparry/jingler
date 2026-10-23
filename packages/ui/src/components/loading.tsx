import type { CSSProperties } from "react"
import { Loader } from "./beui/loader.js"
import { cn } from "../lib/cn.js"

/** Compatibility name backed by BeUI's metaballs loading state. */
export function ThinkingOrb({
  compact = false,
  label = "Agent breathing…",
  className
}: {
  compact?: boolean
  label?: string
  className?: string
}) {
  return <Loader variant="metaballs" size={compact ? 16 : 20} label={label} className={className} />
}

/** Compatibility name backed by the official BeUI spinner. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader variant="spinner" size={size} className={className} />
}

/** Spec §5h skeleton: a row at --bg-elevated with a calm shimmer; static under reduced motion. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={style}
      className={cn(
        "block h-5 rounded-md bg-[linear-gradient(100deg,var(--sb-editor)_30%,var(--sb-surface)_50%,var(--sb-editor)_70%)] bg-[length:220%_100%] animate-shine motion-reduce:animate-none",
        className
      )}
    />
  )
}
