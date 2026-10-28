import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * A monospace keyboard chip. `onFill` sits ON a primary-coloured surface.
 *
 * `onFill` is a translucent scrim of the button's own text colour, NOT another accent. It used to be
 * `bg-blue text-editor`, which was invisible while primary was also blue and
 * became a blue tile floating on a red button the moment primary moved to the
 * brand. A chip on a filled button is a shade of that button — anything else is
 * a second accent competing with the one the button already is.
 *
 * Tinting with the fill's text colour needs no per-variant knowledge: it lands
 * correctly on the neutral primary, on destructive-solid, and on future fills.
 */
export function Kbd({
  children,
  onFill = false,
  className
}: {
  children: ReactNode
  onFill?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[10px] leading-none",
        onFill
          ? "bg-primary-fg/15 text-primary-fg"
          : "border border-line text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}

const MAC_GLYPHS: Record<string, string> = { mod: "⌘", cmd: "⌘", ctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧", enter: "↩", backspace: "⌫", esc: "Esc" }
const PC_GLYPHS: Record<string, string> = { mod: "Ctrl", cmd: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift", enter: "Enter", backspace: "Backspace", esc: "Esc" }

const isMacPlatform = (): boolean =>
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

/** Formats `mod+shift+k` as `⌘⇧K` on macOS and `Ctrl+Shift+K` elsewhere. */
export function formatShortcut(shortcut: string, mac = isMacPlatform()): string {
  const glyphs = mac ? MAC_GLYPHS : PC_GLYPHS
  const parts = shortcut.split("+").map((key) => glyphs[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key))
  return parts.join(mac ? "" : "+")
}

/** A shortcut as one nowrap Kbd unit with the platform's glyphs. */
export function KbdChip({ shortcut, mac, onFill, className }: { shortcut: string; mac?: boolean; onFill?: boolean; className?: string }) {
  return <Kbd onFill={onFill} className={className}>{formatShortcut(shortcut, mac)}</Kbd>
}
