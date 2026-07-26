import { describe, expect, it } from "vitest"
import { Boxes } from "lucide-react"
import { dockedPanes, type PaneContribution } from "./pane-contributions.js"

const pane = (id: string, slot: "right" | "bottom" = "right"): PaneContribution => ({
  id,
  label: id,
  icon: Boxes,
  slot,
  render: () => null
})

/** Stand-in for `effectiveDock` on a wide shell: honours the request. */
const asRequested = (side: "right" | "bottom") => side
/** Stand-in for a narrow shell, where everything is forced to the bottom. */
const forceBottom = () => "bottom" as const

describe("dockedPanes", () => {
  it("groups panes by the side they asked for", () => {
    const { right, bottom } = dockedPanes(
      [pane("a.right"), pane("b.bottom", "bottom")],
      asRequested
    )
    expect(right.map((p) => p.id)).toEqual(["a.right"])
    expect(bottom.map((p) => p.id)).toEqual(["b.bottom"])
  })

  it("honours the shell's placement rule over the plugin's request", () => {
    // A plugin pane must not be the one thing insisting on a column the window
    // has no room for — it goes where the built-in docks go.
    const { right, bottom } = dockedPanes([pane("a.right")], forceBottom)
    expect(right).toHaveLength(0)
    expect(bottom.map((p) => p.id)).toEqual(["a.right"])
  })

  it("orders panes on a side deterministically, not by load order", () => {
    const forward = dockedPanes([pane("zeta.p"), pane("alpha.p")], asRequested)
    const reversed = dockedPanes([pane("alpha.p"), pane("zeta.p")], asRequested)
    expect(forward.right.map((p) => p.id)).toEqual(["alpha.p", "zeta.p"])
    expect(forward.right.map((p) => p.id)).toEqual(reversed.right.map((p) => p.id))
  })

  it("returns empty sides when nothing is contributed", () => {
    const { right, bottom } = dockedPanes([], asRequested)
    expect(right).toEqual([])
    expect(bottom).toEqual([])
  })
})
