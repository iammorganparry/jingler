import { beforeEach, describe, expect, it } from "vitest"
import {
  closeAllSessionViews,
  closeSessionSurface,
  createSessionSurfaceLayout,
  loadSessionSurfaceLayout,
  maxSessionSurfacesForWidth,
  openSessionView,
  pruneSessionSurfaceLayout,
  replaceSessionSurface,
  resizeSessionSurface,
  saveSessionSurfaceLayout,
  selectSessionSurface,
  sessionSurfaceKey,
  splitSessionSurface,
  type SessionSurface
} from "./session-surface-layout.js"

const chat = (id: string): SessionSurface => ({ kind: "chat", id })
const file = (id: string): SessionSurface => ({ kind: "file", id })
const view = (
  id: string,
  chatId?: string
): Extract<SessionSurface, { kind: "view" }> => ({
  kind: "view",
  id,
  ...(chatId ? { chatId } : {})
})

beforeEach(() => localStorage.clear())

describe("session surface layout", () => {
  it("allows two readable inner surfaces inside a typical outer half-pane", () => {
    expect(maxSessionSurfacesForWidth(500)).toBe(2)
    expect(maxSessionSurfacesForWidth(900)).toBe(4)
  })

  it("selects in the focused pane and focuses an already visible surface", () => {
    const split = splitSessionSurface(createSessionSurfaceLayout(chat("a")), file("a.ts"), 1, 4)
    const selected = selectSessionSurface(split, view("browser", "a"))
    expect(selected.panes.map(({ surface }) => sessionSurfaceKey(surface))).toEqual([
      sessionSurfaceKey(chat("a")),
      sessionSurfaceKey(view("browser", "a"))
    ])
    expect(selectSessionSurface(selected, chat("a")).focused).toBe(0)
  })

  it("moves surfaces without duplication and replaces duplicate targets atomically", () => {
    const two = splitSessionSurface(createSessionSurfaceLayout(chat("a")), file("a.ts"), 1, 4)
    const moved = splitSessionSurface(two, chat("a"), 2, 4)
    expect(moved.panes.map(({ surface }) => surface.id)).toEqual(["a.ts", "a"])
    const replaced = replaceSessionSurface(moved, 0, chat("a"))
    expect(replaced.panes.map(({ surface }) => surface.id)).toEqual(["a"])
  })

  it("closes view metadata and always leaves a fallback pane", () => {
    const opened = openSessionView(createSessionSurfaceLayout(chat("a")), view("terminal"))
    const closed = closeSessionSurface(opened, view("terminal"), chat("a"))
    expect(closed.openViews).toEqual([])
    expect(closed.panes).toEqual([{ surface: chat("a"), ratio: 1 }])

    const several = openSessionView(openSessionView(closed, view("browser", "a")), view("changes"))
    const allClosed = closeAllSessionViews(several, chat("a"))
    expect(allClosed.openViews).toEqual([])
    expect(allClosed.panes).toEqual([{ surface: chat("a"), ratio: 1 }])
  })

  it("resizes only neighbours and clamps them to the shared minimum", () => {
    const three = splitSessionSurface(
      splitSessionSurface(createSessionSurfaceLayout(chat("a")), file("a.ts"), 1, 4),
      view("terminal"),
      2,
      4
    )
    const resized = resizeSessionSurface(three, 0, 1)
    expect(resized.panes[0]!.ratio).toBeCloseTo(2 / 3 - 0.15)
    expect(resized.panes[1]!.ratio).toBeCloseTo(0.15)
    expect(resized.panes[2]!.ratio).toBeCloseTo(1 / 3)
  })

  it("restores valid state then prunes stale and duplicate surfaces", () => {
    const layout = splitSessionSurface(
      openSessionView(createSessionSurfaceLayout(chat("a")), view("changes")),
      file("a.ts"),
      1,
      4
    )
    saveSessionSurfaceLayout("s1", layout)
    const restored = loadSessionSurfaceLayout("s1", chat("a"))
    const allowed = new Set([sessionSurfaceKey(chat("a")), sessionSurfaceKey(view("changes"))])
    const pruned = pruneSessionSurfaceLayout(restored, allowed, chat("a"))
    expect(pruned.panes.map(({ surface }) => surface.kind)).toEqual(["view"])
    expect(pruned.openViews.map(({ id }) => id)).toEqual(["changes"])
  })
})
