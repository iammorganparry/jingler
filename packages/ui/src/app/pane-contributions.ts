/**
 * Pane contributions — a plugin's dock panel, beside the terminal and the
 * browser preview.
 *
 * ## Why a pane is not a tab with a different flag
 *
 * A tab belongs to a SESSION, and there can be four on screen at once in a
 * split. A dock belongs to the WINDOW: it is mounted once, outside the pane
 * loop, and takes whichever session currently has focus as a prop. Modelling a
 * dock as a tab would put four copies of a process-wide panel on screen,
 * fighting over the same state — which is exactly the bug `session-split.tsx`
 * hoists the terminal and browser docks out of the pane loop to avoid.
 *
 * So it is a separate contribution point with a separate lifecycle, and a
 * plugin has to say which it wants.
 *
 * ## Why plugin docks share the built-in docks' placement rule
 *
 * `effectiveDock` decides right-vs-bottom against the shell width, and applies
 * the same rule to a dock's own borders and sizing. A plugin pane that chose its
 * own placement could be positioned at the bottom while drawing a left border
 * across the middle of the window. Sharing the rule means placement and
 * appearance cannot disagree.
 */
import type { ReactNode } from "react"
import type { Session } from "@jingler/core"
import type { LucideIcon } from "lucide-react"
import type { DockSide } from "./terminal-panel.js"

/** Where a contributed pane docks. Mirrors `PaneSlot` in `@jingler/core`. */
export type PaneSlot = DockSide

/**
 * One dock panel a plugin adds.
 *
 * `render` receives the focused session, or null when there isn't one — a dock
 * is window-scoped, so "no session" is a state it must handle rather than a
 * reason not to exist.
 */
export interface PaneContribution {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly slot: PaneSlot
  /** Initial size along the docked axis, in px. The operator can resize. */
  readonly defaultSize?: number
  readonly render: (session: Session | null) => ReactNode
}

/** Contributed panes split by the side they dock to. */
export interface DockedPanes {
  readonly right: ReadonlyArray<PaneContribution>
  readonly bottom: ReadonlyArray<PaneContribution>
}

const EMPTY: DockedPanes = { right: [], bottom: [] }

/**
 * Group contributed panes by their resolved side.
 *
 * `resolve` is the same `effectiveDock` the built-in docks use, passed in rather
 * than imported so this module stays free of layout maths and testable on its
 * own. Order within a side is deterministic — by id — so two plugins docking to
 * the same edge do not swap places between renders depending on load order.
 */
export const dockedPanes = (
  panes: ReadonlyArray<PaneContribution>,
  resolve: (side: PaneSlot) => DockSide
): DockedPanes => {
  if (panes.length === 0) return EMPTY

  const right: PaneContribution[] = []
  const bottom: PaneContribution[] = []

  for (const pane of panes) {
    // A plugin's declared side is a REQUEST, resolved against the shell width
    // exactly as the built-in docks' is. On a narrow window everything ends up
    // at the bottom, and a plugin pane must not be the one thing that insists
    // on a column there is no room for.
    if (resolve(pane.slot) === "right") right.push(pane)
    else bottom.push(pane)
  }

  const byId = (a: PaneContribution, b: PaneContribution) => a.id.localeCompare(b.id)
  return { right: right.toSorted(byId), bottom: bottom.toSorted(byId) }
}
