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

/** BeUI loading-state shimmer, kept as a rectangular compatibility primitive. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "block h-5 rounded-md bg-[linear-gradient(100deg,var(--sb-muted),var(--sb-text-bright),var(--sb-muted))] bg-[length:220%_100%] animate-shine opacity-20",
        className
      )}
    />
  )
}
