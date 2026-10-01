import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_DND_MIME, type SplitGroup } from "./split-layout.js"
import { SessionSplit } from "./session-split.js"
import { testSession as session } from "../test-support.js"
import { resetEditorLayouts } from "./editor-layout-machine.js"

afterEach(cleanup)

const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]

/** A group holding `ids`, split evenly, focused on pane `focused`. */
const groupOf = (ids: ReadonlyArray<string>, focused = 0): SplitGroup => ({
  id: "g1",
  panes: ids.map((sessionId) => ({ sessionId, ratio: 1 / ids.length })),
  focused
})

/**
 * jsdom has no real drag-and-drop, so the payload is modelled explicitly: a map
 * of MIME → value, exposing the same `types` / `getData` surface the handlers
 * actually use. `types` is the important half — the dragover path can only read
 * that one.
 */
const transfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (mime: string) => data[mime] ?? "",
  setData: vi.fn(),
  dropEffect: "",
  effectAllowed: ""
})

const sessionDrag = (id: string) => transfer({ [SESSION_DND_MIME]: id })

/**
 * A drop at a known position inside a pane.
 *
 * Two jsdom gaps to paper over. It reports every box as 0×0, so the pane's rect
 * is stubbed and the offset expressed against it. And its `DragEvent` drops the
 * `MouseEvent` half entirely — `fireEvent.drop(el, { clientX })` silently gives
 * the handler `undefined`, which reads as the middle zone whatever you passed.
 * So the coordinate is defined onto the event after construction.
 */
const dropAt = (index: number, fraction: number, sessionId: string) => {
  const pane = screen.getByTestId(`split-pane-${index}`)
  pane.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect
  const event = createEvent.drop(pane, { dataTransfer: sessionDrag(sessionId) })
  Object.defineProperty(event, "clientX", { value: fraction * 100 })
  Object.defineProperty(event, "clientY", { value: 50 })
  fireEvent(pane, event)
}

const renderSplit = (props: Partial<Parameters<typeof SessionSplit>[0]> = {}) =>
  render(
    <SessionSplit
      group={groupOf(["a", "b"])}
      sessions={sessions}
      renderConversation={(s) => <div>transcript {s.id}</div>}
      {...props}
    />
  )

describe("SessionSplit panes", () => {
  it("renders one pane per pane in the group, each showing its OWN session", () => {
    renderSplit()
    expect(within(screen.getByTestId("split-pane-0")).getByText("transcript a")).toBeTruthy()
    expect(within(screen.getByTestId("split-pane-1")).getByText("transcript b")).toBeTruthy()
  })

  it("renders the empty state when there is no group at all", () => {
    renderSplit({ group: null, emptyState: <span>nothing on screen</span> })
    expect(screen.getByText("nothing on screen")).toBeTruthy()
    expect(screen.queryByTestId("split-pane-0")).toBeNull()
  })

  it("skips a pane whose session has gone rather than throwing mid-prune", () => {
    // `prune` removes it on the next tick; this is the frame in between.
    renderSplit({ group: groupOf(["a", "gone"]) })
    expect(screen.queryByText("transcript gone")).toBeNull()
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("focuses a pane on mousedown anywhere inside it", () => {
    const onFocusPane = vi.fn()
    renderSplit({ onFocusPane })
    fireEvent.mouseDown(screen.getByText("transcript b"))
    expect(onFocusPane).toHaveBeenCalledWith(1)
  })

  it("restores each session's selected workspace after switching away and back", () => {
    const { rerender } = renderSplit({
      group: groupOf(["a"]),
      renderFiles: (s) => <div>files {s.id}</div>
    })

    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    expect(screen.getByText("files a")).toBeTruthy()

    rerender(
      <SessionSplit
        group={groupOf(["b"])}
        sessions={sessions}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderFiles={(s) => <div>files {s.id}</div>}
      />
    )
    expect(screen.getByText("transcript b")).toBeTruthy()

    rerender(
      <SessionSplit
        group={groupOf(["a"])}
        sessions={sessions}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderFiles={(s) => <div>files {s.id}</div>}
      />
    )
    expect(screen.getByText("files a")).toBeTruthy()
  })
})

describe("dropping a session onto a pane", () => {
  it("REPLACES the pane's session when dropped in the middle", () => {
    const onReplacePane = vi.fn()
    const onSplitWith = vi.fn()
    renderSplit({ onReplacePane, onSplitWith })
    dropAt(1, 0.5, "c")
    expect(onReplacePane).toHaveBeenCalledWith(1, "c")
    expect(onSplitWith).not.toHaveBeenCalled()
  })

  it("INSERTS a pane before the target when dropped on its left edge", () => {
    const onSplitWith = vi.fn()
    renderSplit({ onSplitWith, onReplacePane: vi.fn() })
    dropAt(1, 0.02, "c")
    expect(onSplitWith).toHaveBeenCalledWith("c", 1)
  })

  it("INSERTS a pane after the target when dropped on its right edge", () => {
    const onSplitWith = vi.fn()
    renderSplit({ onSplitWith, onReplacePane: vi.fn() })
    dropAt(1, 0.98, "c")
    expect(onSplitWith).toHaveBeenCalledWith("c", 2)
  })

  it("ignores a drag that is not one of our sessions", () => {
    // The composer accepts file drops; a pane must not swallow one.
    const onSplitWith = vi.fn()
    const onReplacePane = vi.fn()
    renderSplit({ onSplitWith, onReplacePane })
    fireEvent.drop(screen.getByTestId("split-pane-1"), {
      dataTransfer: transfer({ "text/plain": "hello" })
    })
    expect(onSplitWith).not.toHaveBeenCalled()
    expect(onReplacePane).not.toHaveBeenCalled()
  })
})

describe("session view mounting", () => {
  const views = {
    renderTerminalDock: (s: { id: string }) => <div data-testid="terminal-view">{s.id}</div>,
    renderBrowser: (s: { id: string }) => <div data-testid="browser-view">{s.id}</div>,
    onToggleBrowser: vi.fn(),
    isBrowserActive: () => false
  }

  it("does not eagerly mount Browser or Terminal in every outer pane", () => {
    renderSplit({ group: groupOf(["a", "b", "c"]), ...views })
    expect(screen.queryByTestId("browser-view")).toBeNull()
    expect(screen.queryByTestId("terminal-view")).toBeNull()
  })

  it("opens Browser and Terminal inside only their owning session panes", () => {
    renderSplit(views)
    const first = screen.getByTestId("split-pane-0")
    const second = screen.getByTestId("split-pane-1")

    fireEvent.click(within(first).getByRole("button", { name: "Browser" }))
    expect(within(first).getByTestId("browser-view").textContent).toBe("a")
    expect(within(second).queryByTestId("browser-view")).toBeNull()

    fireEvent.click(within(second).getByRole("button", { name: "Terminal" }))
    expect(within(second).getByTestId("terminal-view").textContent).toBe("b")
    expect(within(first).queryByTestId("terminal-view")).toBeNull()
  })

  it("keeps an opened Browser element across outer focus changes", () => {
    const { rerender } = renderSplit(views)
    const first = screen.getByTestId("split-pane-0")
    fireEvent.click(within(first).getByRole("button", { name: "Browser" }))
    const before = within(first).getByTestId("browser-view")

    rerender(
      <SessionSplit
        group={groupOf(["a", "b"], 1)}
        sessions={sessions}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        {...views}
      />
    )
    expect(within(screen.getByTestId("split-pane-0")).getByTestId("browser-view")).toBe(before)
  })
})
