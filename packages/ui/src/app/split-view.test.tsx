import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SplitGroup } from "./split-layout.js"
import { SplitView } from "./split-view.js"

afterEach(cleanup)

/**
 * A group holding `ids`. The id is derived from the leftmost pane exactly as the
 * real reducers derive it, so these fixtures re-id the way the app does.
 */
const groupOf = (ids: ReadonlyArray<string>, focused = 0): SplitGroup => ({
  id: `g_${ids[0]}`,
  panes: ids.map((sessionId) => ({ sessionId, ratio: 1 / ids.length })),
  focused
})

const renderView = (group: SplitGroup) =>
  render(
    <SplitView group={group} renderPane={(pane) => <div>pane {pane.sessionId}</div>} />
  )

/**
 * Editing a split and switching to a different one used to be one code path, so
 * clicking a session in the sidebar played the whole split choreography: the
 * outgoing pane collapsing to a sliver while the incoming one grew out of one.
 *
 * These pin the classification — an update sharing a session is an EDIT, one
 * sharing none is a SWITCH — through its two observable consequences: whether
 * the panes that leave are still in the DOM afterwards, and whether the panes
 * that stay keep their DOM node (and so their transcript's scroll position and
 * its virtualizer's measurement cache).
 */
describe("SplitView — switching vs editing", () => {
  it("drops the old panes in the SAME commit when nothing carries over", () => {
    const { rerender } = renderView(groupOf(["a"]))
    expect(screen.getByTestId("split-pane-0").dataset.session).toBe("a")

    rerender(<SplitView group={groupOf(["b"])} renderPane={(p) => <div>pane {p.sessionId}</div>} />)

    // No exiting pane left mid-animation: session `a` is gone, not shrinking.
    expect(screen.queryAllByText(/^pane a$/)).toHaveLength(0)
    expect(screen.getByTestId("split-pane-0").dataset.session).toBe("b")
  })

  it("keeps a surviving pane's DOM node across an edit — it must not remount", () => {
    const { rerender } = renderView(groupOf(["a", "b"]))
    const before = screen.getByTestId("split-pane-0")

    // Closing pane `b` shares `a` with what was on screen, so this is an edit.
    rerender(
      <SplitView group={groupOf(["a"])} renderPane={(p) => <div>pane {p.sessionId}</div>} />
    )

    expect(screen.getByTestId("split-pane-0")).toBe(before)
  })

  it("keeps a surviving pane's DOM node when a NEIGHBOUR's session is swapped", () => {
    const { rerender } = renderView(groupOf(["a", "b"]))
    const before = screen.getByTestId("split-pane-0")

    rerender(
      <SplitView group={groupOf(["a", "c"])} renderPane={(p) => <div>pane {p.sessionId}</div>} />
    )

    expect(screen.getByTestId("split-pane-0")).toBe(before)
    // `b` is on its way out under the same testid, so the arriving pane is
    // identified by its content rather than by its index.
    expect(screen.getByText("pane c")).toBeTruthy()
  })

  it("treats a whole-split swap as a switch too, not just a one-pane one", () => {
    const { rerender } = renderView(groupOf(["a", "b"]))

    rerender(
      <SplitView group={groupOf(["c", "d"])} renderPane={(p) => <div>pane {p.sessionId}</div>} />
    )

    expect(screen.queryAllByText(/^pane a$/)).toHaveLength(0)
    expect(screen.queryAllByText(/^pane b$/)).toHaveLength(0)
    expect(screen.getByTestId("split-pane-0").dataset.session).toBe("c")
    expect(screen.getByTestId("split-pane-1").dataset.session).toBe("d")
  })

  it("does not publish chat focus before a toolbar close or move", () => {
    const onFocusPane = vi.fn()
    render(<SplitView group={groupOf(["a", "b"])} onFocusPane={onFocusPane}
      renderPane={() => <><div data-pane-toolbar><button type="button">Close</button></div><p>transcript</p></>} />)
    const close = screen.getAllByRole("button", { name: "Close" })[0]!
    fireEvent.mouseDown(close)
    fireEvent.focus(close)
    expect(onFocusPane).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getAllByText("transcript")[0]!)
    expect(onFocusPane).toHaveBeenCalledWith(0)
  })

  it("does not remeasure pane geometry for focus-only updates, but still measures reordering", async () => {
    const group = groupOf(["a", "b"])
    const body = (pane: { sessionId: string }) => <div>{pane.sessionId}</div>
    const { rerender } = render(<SplitView group={group} renderPane={body} />)
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const measure = vi.spyOn(screen.getByTestId("split-pane-0"), "getBoundingClientRect")
    try {
      rerender(<SplitView group={{ ...group, focused: 1 }} renderPane={body} />)
      expect(measure).not.toHaveBeenCalled()
      rerender(<SplitView group={{ ...group, panes: [...group.panes].reverse() }} renderPane={body} />)
      expect(measure).toHaveBeenCalled()
    } finally {
      measure.mockRestore()
    }
  })

  it("previews divider moves without rerendering pane bodies per pointer move", () => {
    const renders = vi.fn()
    const onResize = vi.fn()
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      left: 0,
      width: 1000,
      height: 700,
      toJSON: () => ({})
    })
    const Body = ({ id }: { id: string }) => {
      renders(id)
      return <div>{id}</div>
    }
    render(
      <SplitView
        group={groupOf(["a", "b"])}
        renderPane={(pane) => <Body id={pane.sessionId} />}
        onResize={onResize}
      />
    )

    fireEvent.pointerDown(screen.getByTestId("split-divider-0"), { clientX: 500 })
    const afterStart = renders.mock.calls.length
    fireEvent.pointerMove(window, { clientX: 520 })
    fireEvent.pointerMove(window, { clientX: 540 })
    fireEvent.pointerMove(window, { clientX: 560 })
    expect(renders).toHaveBeenCalledTimes(afterStart)
    expect(onResize).not.toHaveBeenCalled()
    fireEvent.pointerUp(window)
    expect(onResize).toHaveBeenCalledTimes(1)
    bounds.mockRestore()
  })

  it("renders no add-split affordance — ⌃⇧= and a sidebar drag are the ways in", () => {
    renderView(groupOf(["a"]))
    expect(screen.queryByTestId("add-right-split")).toBeNull()
  })
})
