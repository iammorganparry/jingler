import { cn } from "../lib/cn.js"

const ORB_DOTS = Array.from({ length: 12 }, (_, index) => {
  const angle = (index / 12) * Math.PI * 2 - Math.PI / 2
  return {
    cx: 12 + Math.cos(angle) * 8,
    cy: 12 + Math.sin(angle) * 8,
    opacity: 0.24 + (index / 11) * 0.76
  }
})

/** Dotted breathing orbit used wherever a live agent is between visible output. */
export function ThinkingOrb({
  compact = false,
  label = "Agent breathing…",
  className
}: {
  compact?: boolean
  label?: string
  className?: string
}) {
  const orbit = (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="size-5 flex-none text-muted-foreground [animation:var(--animate-spin-orb)] motion-reduce:animate-none"
    >
      {ORB_DOTS.map((dot, index) => (
        <circle key={index} cx={dot.cx} cy={dot.cy} r="1.15" fill="currentColor" opacity={dot.opacity} />
      ))}
    </svg>
  )

  if (compact) {
    return (
      <span role="status" aria-label={label} title={label} className={cn("inline-flex", className)}>
        {orbit}
      </span>
    )
  }

  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-full bg-sunken px-4 py-2 text-[13px] text-muted-foreground shadow-[0_0_0_1px_var(--sb-line)]",
        className
      )}
    >
      {orbit}
      <span>{label}</span>
    </span>
  )
}

/** A small One Dark spinner. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border-2 border-dim border-t-transparent [animation:var(--animate-spin-fast)]",
        className
      )}
      style={{ width: size, height: size }}
    />
  )
}

/** A shimmering skeleton placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block h-5 rounded-md [background-size:220px_100%] [animation:var(--animate-shine)]",
        "bg-[linear-gradient(90deg,transparent,var(--sb-hover),transparent)]",
        className
      )}
    />
  )
}
