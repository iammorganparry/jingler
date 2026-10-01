import { beforeEach, describe, expect, it } from "vitest"
import {
  activateTab,
  applyEditorCommand,
  activeSurface,
  allTabs,
  closeTabsWhere,
  moveActiveTab,
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

describe("editor layout structural sharing", () => {
  const threeGroups = () => {
    let layout = createEditorLayout([chat("a"), file("x.ts")])
    layout = dropTab(layout, { surface: chat("b") }, firstGroupId(layout), "right")
    return dropTab(layout, { surface: chat("c") }, groupsOf(layout.root)[1]!.id, "bottom")
  }

  it("keeps untouched groups and splits by identity when one group changes", () => {
    const layout = threeGroups()
    const [a, b, c] = groupsOf(layout.root)
    const next = activateTab(layout, a!.id, sessionSurfaceKey(chat("a")))
    const [a2, b2, c2] = groupsOf(next.root)
    expect(a2).not.toBe(a)
    expect(b2).toBe(b)
    expect(c2).toBe(c)
    expect(split(next).children[1]).toBe(split(layout).children[1])
  })

  it("returns the same tree when activating the already-active tab or resizing elsewhere", () => {
    const layout = threeGroups()
    const a = groupsOf(layout.root)[0]!
    expect(activateTab(layout, a.id, a.active).root).toBe(layout.root)
    const inner = split(layout).children[1] as EditorSplit
    const resized = resizeSplit(layout, inner.id, 0, 0.1)
    expect(groupsOf(resized.root)[0]).toBe(a)
    expect(split(resized).children[1]).not.toBe(inner)
  })

  it("keeps identity through a prune that removes nothing, and through closing in another group", () => {
    const layout = threeGroups()
    const all = new Set(groupsOf(layout.root).flatMap((g) => g.tabs).map(sessionSurfaceKey))
    expect(pruneEditorLayout(layout, all)).toBe(layout)
    const [a, b, c] = groupsOf(layout.root)
    const closed = closeTab(layout, a!.id, file("x.ts"))
    expect(groupsOf(closed.root)[1]).toBe(b)
    expect(groupsOf(closed.root)[2]).toBe(c)
  })
})

describe("editor layout helpers", () => {
  it("closes tabs by predicate, lists distinct tabs, and moves the active tab to a neighbour", () => {
    let layout = createEditorLayout([chat("a"), view("pr"), view("terminal")])
    layout = dropTab(layout, { surface: view("pr") }, firstGroupId(layout), "right")
    expect(allTabs(layout).map((t) => t.id)).toEqual(["a", "pr", "terminal"])
    expect(shape(closeTabsWhere(layout, (s) => s.kind === "view"))).toEqual([["a"]])
    const back = focusAdjacentGroup(layout, -1)
    const moved = moveActiveTab(back, 1)
    expect(shape(moved)).toEqual([["a", "pr"], ["pr", "terminal"]])
    expect(moveActiveTab(moved, 1)).toBe(moved)
  })
})

describe("applyEditorCommand", () => {
  it("splits right and down, moves and focuses, and ignores unknown commands", () => {
    const base = createEditorLayout([chat("a")])
    expect(split(applyEditorCommand(base, "split-right")).axis).toBe("row")
    expect(split(applyEditorCommand(base, "split-down")).axis).toBe("column")
    const two = applyEditorCommand(base, "split-right")
    expect(focusedGroup(applyEditorCommand(two, "focus-0"))!.id).toBe(groupsOf(two.root)[0]!.id)
    expect(focusedGroup(applyEditorCommand(two, "focus-left"))!.id).toBe(groupsOf(two.root)[0]!.id)
    expect(applyEditorCommand(two, "focus-9")).toBe(two)
    expect(applyEditorCommand(two, "nope")).toBe(two)
  })
})
