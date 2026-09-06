import type { Chord, SplitShortcut } from "./split-shortcuts.js"
import type { SessionSurfaceCommand } from "./session-surface-layout.js"

export const matchNewTabChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
  (event.code === "KeyT" || event.key.toLowerCase() === "t")

export const matchGlobalSearchChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey &&
  event.key.toLowerCase() === "f"

export const matchTerminalChord = (event: Chord): boolean =>
  event.ctrlKey && !event.metaKey && !event.altKey &&
  (event.code === "Backquote" || event.key === "`")

export const matchBrowserChord = (event: Chord): boolean =>
  event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey &&
  (event.key === "B" || event.code === "KeyB")

export function surfaceCommandForShortcut(shortcut: SplitShortcut): SessionSurfaceCommand | null {
  switch (shortcut.type) {
    case "focus-pane": return `focus-${shortcut.index}` as SessionSurfaceCommand
    case "focus-neighbour": return shortcut.direction === -1 ? "focus-left" : "focus-right"
    case "move-pane": return shortcut.direction === -1 ? "move-left" : "move-right"
    case "close-pane": return "close"
    default: return null
  }
}
