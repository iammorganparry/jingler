import type { Chord, SplitShortcut } from "./split-shortcuts.js"
import type { SessionSurfaceCommand } from "./session-surface-layout.js"
import { BUILTIN_TAB, type TabKey } from "./tab-contributions.js"

export const matchNewTabChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
  (event.code === "KeyT" || event.key.toLowerCase() === "t")

export const matchGlobalSearchChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey &&
  event.key.toLowerCase() === "f"

export const matchTerminalChord = (event: Chord): boolean =>
  event.ctrlKey && !event.metaKey && !event.altKey &&
  (event.code === "Backquote" || event.key === "`")

/** ⌘⇧B (or ⌃⇧B off macOS). */
export const matchBrowserChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey &&
  (event.key.toLowerCase() === "b" || event.code === "KeyB")

/** ⌘⇧D (or ⌃⇧D off macOS) opens Changes. */
export const matchChangesChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey &&
  (event.key.toLowerCase() === "d" || event.code === "KeyD")

/** The shortcut shown beside a built-in tab in the palette. Changes also covers the retired Code Review tab. */
export const tabShortcutHint = (tabId: TabKey): string | undefined => {
  if (tabId === BUILTIN_TAB.browser) return "⌃⇧B"
  if (tabId === BUILTIN_TAB.terminal) return "⌃`"
  if (tabId === BUILTIN_TAB.changes) return "⌘⇧D"
  return undefined
}

/** ⌥1–⌥9 → zero-based position of the header view button to open, matching the physical digit key. */
export const matchHeaderViewChord = (event: Chord): number | null =>
  event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)
    ? Number(event.code.slice(5)) - 1
    : null

export const matchExplorerToggleChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey &&
  (event.key === "E" || event.code === "KeyE")

/** ⌘\\ splits the focused tab right; ⌘⇧\\ splits it down. */
export const matchSplitEditorChord = (event: Chord): "split-right" | "split-down" | null =>
  (event.metaKey || event.ctrlKey) && !event.altKey && (event.code === "Backslash" || event.key === "\\" || event.key === "|")
    ? event.shiftKey ? "split-down" : "split-right"
    : null

export function surfaceCommandForShortcut(shortcut: SplitShortcut): SessionSurfaceCommand | null {
  switch (shortcut.type) {
    case "focus-pane": return `focus-${shortcut.index}` as SessionSurfaceCommand
    case "focus-neighbour": return shortcut.direction === -1 ? "focus-left" : "focus-right"
    case "move-pane": return shortcut.direction === -1 ? "move-left" : "move-right"
    case "close-pane": return "close"
    default: return null
  }
}

export const matchCollapseChatChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
  (event.code === "KeyL" || event.key.toLowerCase() === "l")

export const matchFocusChatChord = (event: Chord): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey &&
  (event.code === "KeyL" || event.key.toLowerCase() === "l")
