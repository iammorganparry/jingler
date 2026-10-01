import { beforeEach, describe, expect, it } from "vitest"
import {
  activeSurface,
  closeSurfaceEverywhere,
  closeTab,
  createEditorLayout,
  dropTab,
  EDITOR_LAYOUT_STORAGE_PREFIX,
  type EditorLayout,
  type EditorSplit,
  focusAdjacentGroup,
  focusedGroup,
  groupsOf,
  loadEditorLayout,
  openTab,
  pruneEditorLayout,
  resizeSplit,
  saveEditorLayout
} from "./editor-layout.js"
import { SESSION_SURFACE_STORAGE_PREFIX, sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"
import { MIN_RATIO } from "./split-layout.js"

const chat = (id: string): SessionSurface => ({ kind: "chat", id })
const file = (id: string): SessionSurface => ({ kind: "file", id })
const view = (id: string): SessionSurface => ({ kind: "view", id })

/** Tab ids per group, in reading order. */
const shape = (layout: EditorLayout) => groupsOf(layout.root).map((g) => g.tabs.map((t) => t.id))
const firstGroupId = (layout: EditorLayout) => groupsOf(layout.root)[0]!.id
const split = (layout: EditorLayout) => layout.root as EditorSplit

beforeEach(() => localStorage.clear())

describe("editor layout", () => {
  it("opens into the focused group and reveals an already-open tab instead of duplicating it", () => {
    let layout = createEditorLayout([chat("main")], "main")
    layout = openTab(layout, file("a.ts"))
    layout = openTab(layout, chat("main"))
    expect(shape(layout)).toEqual([["main", "a.ts"]])
    expect(activeSurface(focusedGroup(layout)!).id).toBe("main")
  })

  it("splits on each edge with the right axis and order", () => {
    const base = createEditorLayout([chat("main")])
    const target = firstGroupId(base)
    const cases = [
      ["left", "row", [["b"], ["main"]]],
      ["right", "row", [["main"], ["b"]]],
      ["top", "column", [["b"], ["main"]]],
      ["bottom", "column", [["main"], ["b"]]]
    ] as const
    for (const [edge, axis, expected] of cases) {
      const next = dropTab(base, { surface: chat("b") }, target, edge)
      expect(split(next).axis).toBe(axis)
      expect(shape(next)).toEqual(expected)
      expect(activeSurface(focusedGroup(next)!).id).toBe("b")
    }
  })

  it("moves a dragged tab, copies it with ⌥, and collapses the group it emptied", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts")])
    layout = dropTab(layout, { surface: file("a.ts"), from: firstGroupId(layout) }, firstGroupId(layout), "right")
    expect(shape(layout)).toEqual([["main"], ["a.ts"]])

    const [left, right] = groupsOf(layout.root)
    const copied = dropTab(layout, { surface: file("a.ts"), from: right!.id }, left!.id, "center", true)
    expect(shape(copied)).toEqual([["main", "a.ts"], ["a.ts"]])

    const moved = dropTab(layout, { surface: file("a.ts"), from: right!.id }, left!.id, "center")
    expect(shape(moved)).toEqual([["main", "a.ts"]])
    expect(moved.root?.type).toBe("group")
  })

  it("flattens same-axis splits and keeps ratios summing to 1", () => {
    let layout = createEditorLayout([chat("a")])
    layout = dropTab(layout, { surface: chat("b") }, firstGroupId(layout), "right")
    layout = dropTab(layout, { surface: chat("c") }, groupsOf(layout.root)[1]!.id, "right")
    expect(split(layout).children).toHaveLength(3)
    expect(split(layout).ratios.reduce((s, r) => s + r, 0)).toBeCloseTo(1)

    // A column nested in the row survives; closing its other half collapses it back.
    layout = dropTab(layout, { surface: view("terminal") }, groupsOf(layout.root)[0]!.id, "bottom")
    expect(split(layout).children[0]!.type).toBe("split")
    const terminalGroup = groupsOf(layout.root).find((g) => g.tabs[0]!.id === "terminal")!
    layout = closeTab(layout, terminalGroup.id, view("terminal"))
    expect(shape(layout)).toEqual([["a"], ["b"], ["c"]])
    expect(split(layout).children.every((c) => c.type === "group")).toBe(true)
  })

  it("closes a surface in every group and records the main chat as explicitly closed", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts")], "main")
    layout = dropTab(layout, { surface: chat("main") }, firstGroupId(layout), "right")
    const oneCopy = closeTab(layout, groupsOf(layout.root)[1]!.id, chat("main"))
    expect(oneCopy.mainChatId).toBe("main")

    const everywhere = closeSurfaceEverywhere(layout, chat("main"))
    expect(shape(everywhere)).toEqual([["a.ts"]])
    expect(everywhere.mainChatId).toBeNull()

    saveEditorLayout("s", everywhere)
    expect(shape(loadEditorLayout("s", file("a.ts"), "main"))).toEqual([["a.ts"]])
  })

  it("leaves an empty layout when the last tab closes", () => {
    const layout = createEditorLayout([file("a.ts")])
    const closed = closeTab(layout, firstGroupId(layout), file("a.ts"))
    expect(closed.root).toBeNull()
    expect(closed.focusedGroupId).toBeNull()
    expect(shape(openTab(closed, file("b.ts")))).toEqual([["b.ts"]])
  })

  it("clamps resizing to the minimum share", () => {
    let layout = createEditorLayout([chat("a")])
    layout = dropTab(layout, { surface: chat("b") }, firstGroupId(layout), "right")
    const resized = resizeSplit(layout, split(layout).id, 0, 5)
    expect(split(resized).ratios[1]).toBeCloseTo(MIN_RATIO)
    expect(resizeSplit(layout, split(layout).id, 0, Number.NaN)).toBe(layout)
  })

  it("moves focus through groups in reading order and stops at the ends", () => {
    let layout = createEditorLayout([chat("a")])
    layout = dropTab(layout, { surface: chat("b") }, firstGroupId(layout), "right")
    const back = focusAdjacentGroup(layout, -1)
    expect(activeSurface(focusedGroup(back)!).id).toBe("a")
    expect(focusAdjacentGroup(back, -1)).toBe(back)
  })

  it("prunes deleted surfaces and returns the same object when nothing changed", () => {
    let layout = createEditorLayout([chat("a"), file("gone.ts")])
    layout = dropTab(layout, { surface: chat("b") }, firstGroupId(layout), "right")
    const allowed = new Set([chat("a"), chat("b"), file("gone.ts")].map(sessionSurfaceKey))
    expect(pruneEditorLayout(layout, allowed)).toBe(layout)
    allowed.delete(sessionSurfaceKey(chat("b")))
    allowed.delete(sessionSurfaceKey(file("gone.ts")))
    expect(shape(pruneEditorLayout(layout, allowed))).toEqual([["a"]])
  })

  it("migrates the v1 surface list into a row of groups, keeping open views and focus", () => {
    localStorage.setItem(
      `${SESSION_SURFACE_STORAGE_PREFIX}s`,
      JSON.stringify({
        mainChatId: "main",
        panes: [
          { surface: chat("main"), ratio: 0.6 },
          { surface: file("a.ts"), ratio: 0.4 }
        ],
        focused: 1,
        openViews: [view("pr")]
      })
    )
    const layout = loadEditorLayout("s", chat("main"), "main")
    expect(shape(layout)).toEqual([["main"], ["a.ts", "pr"]])
    expect(split(layout).ratios).toEqual([0.6, 0.4])
    expect(focusedGroup(layout)!.tabs[0]!.id).toBe("a.ts")
  })

  it("puts back a live main chat that went missing, unless it was closed", () => {
    saveEditorLayout("s", createEditorLayout([file("a.ts")]))
    expect(shape(loadEditorLayout("s", file("a.ts"), "main"))).toEqual([["main", "a.ts"]])
  })

  it("round-trips a nested layout and rejects bad payloads", () => {
    let layout = createEditorLayout([chat("a")])
    layout = dropTab(layout, { surface: file("b.ts") }, firstGroupId(layout), "bottom")
    saveEditorLayout("s", layout)
    expect(loadEditorLayout("s", chat("a"))).toEqual(layout)

    localStorage.setItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}bad`, "{not json")
    expect(shape(loadEditorLayout("bad", chat("x"), "main"))).toEqual([["main", "x"]])
    localStorage.setItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}junk`, JSON.stringify({ root: { type: "nope" } }))
    expect(shape(loadEditorLayout("junk", chat("x")))).toEqual([["x"]])
  })
})
