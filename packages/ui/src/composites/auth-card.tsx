import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { JinglerMark } from "../brand/jingler-mark.js"

export interface AuthCardProps {
  /** Card heading, e.g. "Sign in to Jingler". */
  title: string
  /** Supporting line under the heading. */
  subtitle?: string
  /** The auth controls (OAuth buttons, divider, magic-link form, …). */
  children: ReactNode
  className?: string
}

/**
 * The sign-in card chrome: the brand mark, heading + subtitle, and a neutral
 * lift shadow, wrapping whatever auth controls are slotted in. A molecule so the same
 * shell can host sign-in, sign-up, or recovery bodies later.
 *
 * Opaque, on a flat canvas. It briefly sat translucent over an animated
 * backdrop; with nothing behind it to show through, a blur is pure cost and a
 * translucent panel just makes the border read as smudged.
 *
 * The brand mark is the only rose on the card: buttons and links stay neutral.
 */
export function AuthCard({ title, subtitle, children, className }: AuthCardProps) {
  return (
    <div
      className={cn(
        "relative z-10 flex w-[328px] flex-col items-center rounded-xl border border-line bg-panel px-7 pb-6 pt-7 shadow-[0_10px_30px_-12px_var(--sb-shadow-strong)]",
        className
      )}
    >
      {/*
        No tile behind the mark. The card is already a rounded rectangle on a
        rounded-rectangle-free field, and boxing the logo inside a second one
        made the header read as a favicon rather than as a brand mark. The glyph
        carries itself at this size.
      */}
      <JinglerMark className="mb-4 h-8 w-auto text-brand" />
      <h1 className="mb-1.5 text-center text-[17px] font-semibold tracking-[-0.01em] text-text-bright">
        {title}
      </h1>
      {subtitle ? (
        <p className="mb-5 text-center text-[12px] leading-snug text-text">{subtitle}</p>
      ) : null}
      <div className="flex w-full flex-col items-center gap-4">{children}</div>
    </div>
  )
}
