import type { ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"

// Tones collapse onto BannerShell styling (#376): neutral body for every tone; only `red` colours its glyph.
const callout = cva("flex items-center gap-[9px] rounded-xl border border-line px-[11px] py-[9px] text-[11.5px]", {
  variants: {
    tone: { yellow: "", green: "", blue: "", red: "", purple: "" }
  },
  defaultVariants: { tone: "yellow" }
})

const iconColor = (tone: string) => (tone === "red" ? "text-state-failed" : "text-muted-foreground")

const defaultGlyph: Record<string, string> = {
  yellow: "!",
  green: "✓",
  blue: "i",
  red: "✗",
  purple: "✓"
}

export interface CalloutProps extends VariantProps<typeof callout> {
  children: ReactNode
  glyph?: ReactNode
  className?: string
}

/** An inline notice with a leading glyph (One Dark, rounded-xl = 7px). */
export function Callout({ children, tone = "yellow", glyph, className }: CalloutProps) {
  return (
    <div className={cn(callout({ tone }), className)}>
      <span className={cn("flex-none", iconColor(tone ?? "yellow"))}>
        {glyph ?? defaultGlyph[tone ?? "yellow"]}
      </span>
      <span className="text-text">{children}</span>
    </div>
  )
}
