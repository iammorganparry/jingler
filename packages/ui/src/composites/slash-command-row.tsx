import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { HighlightMatch } from "../components/highlight-match.js"

/** A row in the slash-command palette. */
export function SlashCommandRow({
  name,
  description,
  glyph = "/",
  glyphTone = "blue",
  badge,
  badgeTone = "count",
  active = false,
  query = "",
  className
}: {
  name: string
  description: string
  glyph?: ReactNode
  glyphTone?: "blue" | "purple"
  badge?: ReactNode
  badgeTone?: "count" | "purple"
  active?: boolean
  /** Typed text emphasised inside `name`. */
  query?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 whitespace-nowrap rounded-md px-[9px] py-[7px]",
        active && "bg-surface",
        className
      )}
    >
      <span
        className={cn(
          "flex size-[22px] flex-none items-center justify-center rounded-md font-mono text-[12px]",
          glyphTone === "blue" ? "bg-blue/[0.14] text-blue" : "bg-purple/[0.14] text-purple"
        )}
      >
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-text-bright">
          <HighlightMatch text={name} query={query} />
        </div>
        <div className="truncate text-[10px] text-dim">{description}</div>
      </div>
      {badge && (
        <Badge tone={badgeTone} size="xs">
          {badge}
        </Badge>
      )}
    </div>
  )
}
