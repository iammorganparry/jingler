import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { DropZoneOverlay, resolveDropEdge } from "./drop-zone-overlay.js"

afterEach(cleanup)

const rect = { left: 100, top: 50, width: 400, height: 200 }

describe("resolveDropEdge", () => {
  it.each([
    { name: "left band", x: 110, y: 150, edge: "left" },
    { name: "right band", x: 490, y: 150, edge: "right" },
    { name: "top band", x: 300, y: 55, edge: "top" },
    { name: "bottom band", x: 300, y: 245, edge: "bottom" },
    { name: "middle", x: 300, y: 150, edge: "center" },
    { name: "just inside the left band", x: 100 + 99, y: 150, edge: "left" },
    { name: "exactly on the left band boundary", x: 100 + 100, y: 150, edge: "center" },
    { name: "just inside the right band", x: 500 - 99, y: 150, edge: "right" },
    { name: "just inside the top band", x: 300, y: 50 + 49, edge: "top" },
    { name: "exactly on the top band boundary", x: 300, y: 50 + 50, edge: "center" },
    { name: "top-left corner is the nearest side", x: 100, y: 50, edge: "left" },
    { name: "corner nearer the top", x: 105, y: 52, edge: "top" },
    { name: "outside the box still resolves to the nearest side", x: 0, y: 150, edge: "left" }
  ] as const)("$name → $edge", ({ x, y, edge }) => {
    expect(resolveDropEdge(rect, x, y)).toBe(edge)
  })

  it("is the centre for a collapsed box", () => {
    expect(resolveDropEdge({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe("center")
  })
})

describe("DropZoneOverlay", () => {
  it("renders five labelled zones and highlights only the hovered one", () => {
    render(<DropZoneOverlay edge="right" />)
    const zones = screen.getAllByTestId("editor-drop-zone")
    expect(zones.map((zone) => zone.getAttribute("data-zone"))).toEqual(["left", "right", "top", "bottom", "center"])
    expect(zones.filter((zone) => zone.getAttribute("data-active") === "true").map((zone) => zone.getAttribute("data-zone"))).toEqual(["right"])
    for (const label of ["Split left", "Split right", "Split up", "Split down", "Move here"]) expect(screen.getByText(label)).toBeTruthy()
  })

  it("is a single wash without zones for a tab strip", () => {
    render(<DropZoneOverlay edge="center" zones={false} />)
    expect(screen.queryAllByTestId("editor-drop-zone")).toHaveLength(0)
    expect(screen.getByTestId("editor-drop-overlay").getAttribute("data-edge")).toBe("center")
  })
})
