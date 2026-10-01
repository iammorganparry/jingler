import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { activateTab, type EditorLayout } from "./editor-layout.js"
import { EditorGroups } from "./editor-groups.js"
import { sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"

const chat = (id: string): SessionSurface => ({ kind: "chat", id })
const file = (id: string): SessionSurface => ({ kind: "file", id })
const a = chat("a")
const source = file("src/a.ts")
const b = chat("b")
const layout: EditorLayout = {
  focusedGroupId: "left",
  root: {
    type: "split",
    id: "root",
    axis: "row",
    ratios: [0.5, 0.5],
    children: [
      { type: "group", id: "left", tabs: [a, source], active: sessionSurfaceKey(a) },
      { type: "group", id: "right", tabs: [b], active: sessionSurfaceKey(b) }
    ]
  }
}

afterEach(cleanup)

const props = (renderBody: (surface: SessionSurface) => ReactNode, onResize = vi.fn()) => ({
  sessionId: "session",
  revision: layout,
  describe: (surface: SessionSurface) => ({ label: surface.id }),
  renderBody,
  onActivate: vi.fn(),
  onClose: vi.fn(),
  onDrop: vi.fn(),
  onFocusGroup: vi.fn(),
  onResize
})

describe("EditorGroups rendering", () => {
  it("re-renders only the group whose active tab changed", () => {
    const renders = new Map<string, number>()
    const renderBody = (surface: SessionSurface) => {
      renders.set(surface.id, (renders.get(surface.id) ?? 0) + 1)
      return <span>{surface.id}</span>
    }
    const view = render(<EditorGroups {...props(renderBody)} layout={layout} />)
    expect(renders).toEqual(new Map([["a", 1], ["src/a.ts", 1], ["b", 1]]))

    view.rerender(
      <EditorGroups
        {...props(renderBody)}
        layout={activateTab(layout, "left", sessionSurfaceKey(source))}
      />
    )

    expect(renders.get("a")).toBe(2)
    expect(renders.get("src/a.ts")).toBe(1)
    expect(renders.get("b")).toBe(1)
  })

  it("previews divider movement without rendering bodies and commits once on release", () => {
    const renderBody = vi.fn((surface: SessionSurface) => <span>{surface.id}</span>)
    const onResize = vi.fn()
    render(<EditorGroups {...props(renderBody, onResize)} layout={layout} />)
    const initialRenders = renderBody.mock.calls.length
    const divider = screen.getByRole("separator", { name: "Resize editor group 1" })
    const container = divider.parentElement!
    container.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600,
      toJSON: () => ({})
    })

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600 })
    expect(renderBody).toHaveBeenCalledTimes(initialRenders)
    expect(onResize).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 600 })
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]?.slice(0, 2)).toEqual(["root", 0])
    expect(onResize.mock.calls[0]?.[2]).toBeCloseTo(0.1)
  })
})
