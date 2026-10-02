import { beforeEach, describe, expect, it } from "vitest"
import {
  activateTab,
  applyEditorCommand,
  activeSurface,
  allTabs,
  closeSurfaceEverywhere,
  closeTab,
  createEditorLayout,
  dropTab,
  EDITOR_LAYOUT_STORAGE_PREFIX,
  type EditorLayout,
  type EditorSplit,
  focusedGroup,
  groupsOf,
  loadEditorLayout,
  openTab,
  pruneEditorLayout,
  resizedPair,
  resizeSplit,
  saveEditorLayout
} from "./editor-layout.js"
import { SESSION_SURFACE_STORAGE_PREFIX, sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"
import { MIN_RATIO } from "./split-layout.js"

const chat = (id: string): SessionSurface => ({ kind: "chat", id })
const file = (id: string): SessionSurface => ({ kind: "file", id })
const view = (id: string, chatId?: string): SessionSurface => ({ kind: "view", id, ...(chatId ? { chatId } : {}) })
const shape = (layout: EditorLayout) => groupsOf(layout.root).map((group) => group.tabs.map((tab) => `${tab.kind}:${tab.id}`))
const split = (layout: EditorLayout) => layout.root as EditorSplit

beforeEach(() => localStorage.clear())

describe("editor layout lanes", () => {
  it("keeps chat-only layouts full width and groups every chat into one pane", () => {
    let layout = createEditorLayout([chat("main")], "main")
    expect(layout.root?.type).toBe("group")
    layout = openTab(layout, chat("side"))
    expect(layout.root?.type).toBe("group")
    expect(shape(layout)).toEqual([["chat:main", "chat:side"]])
    expect(activeSurface(focusedGroup(layout)!).id).toBe("side")
  })

  it("opens files and views in one right pane at 1/3–2/3", () => {
    let layout = createEditorLayout([chat("main")], "main")
    layout = openTab(layout, file("a.ts"))
    layout = openTab(layout, view("terminal"))
    expect(shape(layout)).toEqual([["chat:main"], ["file:a.ts", "view:terminal"]])
    expect(split(layout).axis).toBe("row")
    expect(split(layout).ratios).toEqual([1 / 3, 2 / 3])
    expect(activeSurface(focusedGroup(layout)!).id).toBe("terminal")
  })

  it("reveals existing tabs without duplicates and no-ops repeated activation", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts")], "main")
    const content = groupsOf(layout.root)[1]!
    layout = activateTab(layout, content.id, sessionSurfaceKey(file("a.ts")))
    expect(activateTab(layout, content.id, sessionSurfaceKey(file("a.ts")))).toBe(layout)
    expect(openTab(layout, file("a.ts"))).toBe(layout)
    expect(allTabs(layout)).toHaveLength(2)
  })

  it("keeps the active tab and focused lane when a background tab closes", () => {
    let layout = createEditorLayout([chat("a"), chat("b"), chat("c"), file("a.ts"), file("b.ts")])
    const [chats, content] = groupsOf(layout.root)
    layout = activateTab(layout, chats!.id, sessionSurfaceKey(chat("c")))
    layout = closeTab(layout, chats!.id, chat("a"))
    expect(activeSurface(groupsOf(layout.root)[0]!).id).toBe("c")

    layout = closeTab(layout, content!.id, file("a.ts"))
    expect(activeSurface(focusedGroup(layout)!).id).toBe("c")
    expect(activeSurface(groupsOf(layout.root)[1]!).id).toBe("b.ts")
  })

  it("collapses to full-width chat when the last content tab closes", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts"), view("terminal")], "main")
    const contentId = groupsOf(layout.root)[1]!.id
    layout = closeTab(layout, contentId, file("a.ts"))
    layout = closeSurfaceEverywhere(layout, view("terminal"))
    expect(layout.root?.type).toBe("group")
    expect(shape(layout)).toEqual([["chat:main"]])
  })

  it("keeps content full width when every chat is explicitly closed", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts")], "main")
    layout = closeSurfaceEverywhere(layout, chat("main"))
    expect(layout.root?.type).toBe("group")
    expect(shape(layout)).toEqual([["file:a.ts"]])
    expect(layout.mainChatId).toBeNull()
  })

  it("remembers a resized divider and clamps it to the minimum share", () => {
    const layout = createEditorLayout([chat("main"), file("a.ts")])
    const resized = resizeSplit(layout, split(layout).id, 0, 0.1)
    expect(split(resized).ratios[0]).toBeCloseTo(1 / 3 + 0.1)
    const clamped = resizeSplit(layout, split(layout).id, 0, 5)
    expect(split(clamped).ratios[1]).toBeCloseTo(MIN_RATIO)
    expect(resizeSplit(layout, split(layout).id, 1, 0.1)).toBe(layout)
  })

  it("treats retired split and move commands as no-ops while focus commands still work", () => {
    const chatOnly = createEditorLayout([chat("main")])
    expect(applyEditorCommand(chatOnly, "split-right")).toBe(chatOnly)
    const layout = openTab(chatOnly, file("a.ts"))
    const focusedLeft = applyEditorCommand(layout, "focus-left")
    expect(focusedGroup(focusedLeft)!.tabs[0]!.kind).toBe("chat")
    expect(applyEditorCommand(focusedLeft, "move-right")).toBe(focusedLeft)
  })

  it("routes center drops back to the matching chat or content lane", () => {
    const layout = createEditorLayout([chat("main"), chat("side"), file("a.ts")])
    const [chats, content] = groupsOf(layout.root)
    const moved = dropTab(layout, { surface: chat("side"), from: chats!.id }, content!.id, "center")
    expect(shape(moved)).toEqual([["chat:main", "chat:side"], ["file:a.ts"]])
    expect(focusedGroup(moved)!.id).toBe(chats!.id)
  })

  it("keeps each native Browser surface in one group", () => {
    const browser = view("browser", "chat-a")
    const layout = createEditorLayout([chat("main"), browser])
    const content = groupsOf(layout.root)[1]!

    const altDropped = dropTab(layout, { surface: browser, from: content.id }, content.id, "bottom", true)
    expect(shape(altDropped)).toEqual([["chat:main"], ["view:browser"]])

    const sidebarDropped = dropTab(layout, { surface: browser }, content.id, "right")
    expect(shape(sidebarDropped)).toEqual([["chat:main"], ["view:browser"]])

    const closed = closeTab(altDropped, content.id, browser)
    expect(allTabs(closed)).not.toContainEqual(browser)
  })

  it("moves file and view tabs into horizontal or vertical edge splits", () => {
    const horizontal = createEditorLayout([chat("main"), file("a.ts"), view("terminal")])
    const horizontalContent = groupsOf(horizontal.root)[1]!
    const movedRight = dropTab(
      horizontal,
      { surface: view("terminal"), from: horizontalContent.id },
      horizontalContent.id,
      "right"
    )
    expect(shape(movedRight)).toEqual([["chat:main"], ["file:a.ts"], ["view:terminal"]])
    expect(split(movedRight).axis).toBe("row")

    const vertical = createEditorLayout([chat("main"), file("a.ts"), view("terminal")])
    const verticalContent = groupsOf(vertical.root)[1]!
    const movedDown = dropTab(
      vertical,
      { surface: view("terminal"), from: verticalContent.id },
      verticalContent.id,
      "bottom"
    )
    expect(shape(movedDown)).toEqual([["chat:main"], ["file:a.ts"], ["view:terminal"]])
    expect(split(movedDown).children[1]!.type).toBe("split")
    expect((split(movedDown).children[1] as EditorSplit).axis).toBe("column")
  })

  it("prunes unavailable tabs without disturbing the other lane", () => {
    const layout = createEditorLayout([chat("main"), file("gone.ts"), view("terminal")])
    const allowed = new Set([chat("main"), view("terminal")].map(sessionSurfaceKey))
    expect(shape(pruneEditorLayout(layout, allowed))).toEqual([["chat:main"], ["view:terminal"]])
  })
})

describe("editor layout persistence", () => {
  it("restores saved arbitrary editor groups", () => {
    localStorage.setItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}s`, JSON.stringify({
      focusedGroupId: "mixed",
      root: {
        type: "split",
        id: "old",
        axis: "column",
        ratios: [0.5, 0.5],
        children: [
          { type: "group", id: "mixed", tabs: [file("a.ts"), chat("main")], active: sessionSurfaceKey(file("a.ts")) },
          { type: "group", id: "other", tabs: [chat("side"), view("terminal")], active: sessionSurfaceKey(chat("side")) }
        ]
      }
    }))
    const layout = loadEditorLayout("s", chat("main"), "main")
    expect(shape(layout)).toEqual([["file:a.ts", "chat:main"], ["chat:side", "view:terminal"]])
    expect(split(layout).axis).toBe("column")
    expect(split(layout).ratios).toEqual([0.5, 0.5])
  })

  it("migrates v1 panes and restores a missing live main chat", () => {
    localStorage.setItem(`${SESSION_SURFACE_STORAGE_PREFIX}s`, JSON.stringify({
      panes: [{ surface: file("a.ts"), ratio: 1 }],
      focused: 0,
      openViews: [view("terminal")]
    }))
    const loaded = loadEditorLayout("s", file("a.ts"), "main")
    expect(shape(loaded)).toEqual([
      ["chat:main"],
      ["file:a.ts", "view:terminal"]
    ])
    expect(activeSurface(focusedGroup(loaded)!).id).toBe("a.ts")
  })

  it("does not restore an explicitly closed main chat", () => {
    let layout = createEditorLayout([chat("main"), file("a.ts")], "main")
    layout = closeSurfaceEverywhere(layout, chat("main"))
    saveEditorLayout("s", layout)
    expect(shape(loadEditorLayout("s", file("a.ts"), "main"))).toEqual([["file:a.ts"]])
  })

  it("falls back safely for invalid storage", () => {
    localStorage.setItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}bad`, "{not json")
    expect(shape(loadEditorLayout("bad", chat("main"), "main"))).toEqual([["chat:main"]])
  })
})

describe("editor layout helpers", () => {
  it("keeps starved divider pairs non-negative", () => {
    const pair = resizedPair(0.02, 0.03, 1)!
    expect(pair[0]).toBeCloseTo(0.025)
    expect(pair[1]).toBeCloseTo(0.025)
  })
})
