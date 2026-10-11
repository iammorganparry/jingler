import { Children, useState, type ReactNode } from "react"
import { JinglerMark } from "../brand/jingler-mark.js"
import { cn } from "../lib/cn.js"
import { Badge } from "./badge.js"

const toneBg: Record<string, string> = {
  blue: "bg-blue",
  orange: "bg-orange",
  dim: "bg-dim",
  green: "bg-green",
  purple: "bg-purple"
}

/** A GitHub avatar image URL derived from a login (redirects to the real avatar). */
export const githubAvatarUrl = (login: string, size = 48): string =>
  `https://github.com/${encodeURIComponent(login)}.png?size=${size}`

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * A round author avatar. Standard sizes are 16 / 20 / 24 / 32; any px number is
 * accepted so existing call sites keep working.
 *
 * Fallback order: `src` image → (on error, or without `src`) the `initial`
 * monogram, e.g. "MP". `agent` replaces both with the mono Jingler mark, for
 * agent-authored comments. `count` adds a one-line reply-count badge. With
 * `onClick` the avatar is a `<button>`, reachable with Tab; `label` is its
 * accessible name (the author).
 */
export function Avatar({
  count,
  onClick,
  label,
  initial,
  ...face
}: {
  /** Monogram text, one or two letters. Also the image alt when `label` is absent. */
  initial: string
  /** Optional image URL; falls back to the monogram on error. */
  src?: string | null
  tone?: keyof typeof toneBg
  size?: number
  /** Agent author: render the mono Jingler mark instead of an image or initials. */
  agent?: boolean
  /** Accessible name (the author). */
  label?: string
  /** Reply count shown as a one-line badge; hidden when absent or 0. */
  count?: number
  onClick?: () => void
  className?: string
}) {
  const inner = <AvatarFace initial={initial} label={label} {...face} />
  if (!count && !onClick) return inner
  const badge = count ? (
    <Badge tone="count" size="xs" className="absolute -right-1.5 -top-1.5">
      {count}
    </Badge>
  ) : null
  const wrapperClass = cn("relative inline-flex flex-none rounded-full", FOCUS)
  return onClick ? (
    <button type="button" aria-label={label ?? initial} onClick={onClick} className={wrapperClass}>
      {inner}
      {badge}
    </button>
  ) : (
    <span className={wrapperClass}>
      {inner}
      {badge}
    </span>
  )
}

function AvatarFace({
  initial,
  src,
  tone = "blue",
  size = 26,
  agent = false,
  label,
  className
}: {
  initial: string
  src?: string | null
  tone?: keyof typeof toneBg
  size?: number
  agent?: boolean
  label?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const dim = { width: size, height: size }

  if (agent) {
    return (
      <span
        className={cn("inline-flex flex-none items-center justify-center rounded-full bg-hover text-text-body", className)}
        style={dim}
        data-avatar-kind="agent"
      >
        <JinglerMark role="presentation" aria-label={undefined} aria-hidden style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    )
  }
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={label ?? initial}
        onError={() => setFailed(true)}
        className={cn("inline-block flex-none rounded-full object-cover", className)}
        style={dim}
        data-avatar-kind="image"
      />
    )
  }
  return (
    <span
      aria-label={label}
      role={label ? "img" : undefined}
      className={cn(
        "inline-flex flex-none items-center justify-center whitespace-nowrap rounded-full font-bold text-editor",
        toneBg[tone],
        className
      )}
      style={{ ...dim, fontSize: Math.round(size * (initial.length > 1 ? 0.34 : 0.38)) }}
      data-avatar-kind="initials"
    >
      {initial}
    </span>
  )
}

/** Overlap between stacked avatars, in px. */
const STACK_OVERLAP = 6

/**
 * Avatars in one non-wrapping row, each overlapping the previous by 6px. With
 * `max`, extra avatars collapse into a trailing `+N` circle.
 */
export function AvatarStack({
  children,
  max,
  size = 20,
  className
}: {
  children: ReactNode
  max?: number
  /** Size of the `+N` circle; match the avatars. */
  size?: number
  className?: string
}) {
  const items = Children.toArray(children)
  const shown = max === undefined ? items : items.slice(0, max)
  const extra = items.length - shown.length
  const slot = "inline-flex flex-none rounded-full ring-2 ring-canvas"
  return (
    <span role="group" className={cn("inline-flex flex-nowrap items-center", className)}>
      {shown.map((child, i) => (
        <span key={i} className={slot} style={{ marginLeft: i === 0 ? 0 : -STACK_OVERLAP }}>
          {child}
        </span>
      ))}
      {extra > 0 && (
        <span
          className={cn(slot, "items-center justify-center whitespace-nowrap bg-hover font-mono text-text-body")}
          style={{ marginLeft: shown.length === 0 ? 0 : -STACK_OVERLAP, width: size, height: size, fontSize: Math.round(size * 0.4) }}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}
