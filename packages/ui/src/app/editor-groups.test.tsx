import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, type ReactNode } from "react"
import { Plus } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { activateTab, type EditorLayout } from "./editor-layout.js"
import { EditorGroups, editorFileMime, editorTabMime } from "./editor-groups.js"
import { sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"

const chat = (id: string): SessionSurface => ({ kind: "chat", id })
const file = (id: string): SessionSurface => ({ kind: "file", id })
const view = (id: string): SessionSurface => ({ kind: "view", id })
const a = chat("a")
const source = file("src/a.ts")
const b = chat("b")
const layout: EditorLayout = {
  focusedGroupId: "left",
  root: {
    type: "split",
    id: "root",
    axis: "row",
    ratios: [1 / 3, 2 / 3],
    children: [
      { type: "group", id: "left", tabs: [a, b], active: sessionSurfaceKey(a) },
      { type: "group", id: "right", tabs: [source], active: sessionSurfaceKey(source) }
    ]
  }
}

afterEach(cleanup)

const props = (
  renderBody: (surface: SessionSurface, ctx: { focused: boolean; visible: boolean }) => ReactNode,
  onResize = vi.fn()
) => ({
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
        layout={activateTab(layout, "left", sessionSurfaceKey(b))}
      />
    )

    expect(renders.get("a")).toBe(2)
    expect(renders.get("b")).toBe(2)
    expect(renders.get("src/a.ts")).toBe(1)
  })

  it("preserves mounted body state when a group is nested under a new split", () => {
    const renderBody = (surface: SessionSurface) =>
      surface.id === "a" ? <input aria-label="steering draft" defaultValue="" /> : null
    const rendered = render(<EditorGroups {...props(renderBody)} layout={layout} />)
    const draft = screen.getByLabelText("steering draft") as HTMLInputElement
    fireEvent.change(draft, { target: { value: "unsent steering text" } })
    const root = layout.root!
    if (root.type !== "split") throw new Error("expected split")
    const [left, right] = root.children
    const nested: EditorLayout = {
      ...layout,
      root: {
        ...root,
        children: [{
          type: "split",
          id: "nested",
          axis: "column",
          ratios: [0.5, 0.5],
          children: [left!, {
            type: "group",
            id: "below",
            tabs: [view("terminal")],
            active: sessionSurfaceKey(view("terminal"))
          }]
        }, right!]
      }
    }

    rendered.rerender(<EditorGroups {...props(renderBody)} layout={nested} />)

    expect(screen.getByLabelText("steering draft")).toBe(draft)
    expect(draft.value).toBe("unsent steering text")

    rendered.rerender(<EditorGroups {...props(renderBody)} layout={layout} />)
    expect(screen.getByLabelText("steering draft")).toBe(draft)
    expect(draft.value).toBe("unsent steering text")
  })

  it("invalidates mounted bodies when rendering dependencies change", () => {
    let value = "first"
    const renderBody = () => <span>{value}</span>
    const view = render(<EditorGroups {...props(renderBody)} layout={layout} revision="one" />)
    expect(screen.getAllByText("first")).toHaveLength(3)

    value = "second"
    view.rerender(<EditorGroups {...props(renderBody)} layout={layout} revision="two" />)
    expect(screen.getAllByText("second")).toHaveLength(3)
  })

  it("keeps visibility independent from editor-group focus", () => {
    const renderBody = (surface: SessionSurface, ctx: { focused: boolean; visible: boolean }) => (
      <span data-testid={`state-${surface.id}`}>{`${ctx.focused}:${ctx.visible}`}</span>
    )
    const view = render(<EditorGroups {...props(renderBody)} layout={layout} />)
    expect(screen.getByTestId("state-b").textContent).toBe("false:false")

    view.rerender(<EditorGroups {...props(renderBody)} layout={{ ...layout, focusedGroupId: "right" }} />)
    expect(screen.getByTestId("state-src/a.ts").textContent).toBe("false:true")
    expect(screen.getByTestId("state-a").textContent).toBe("false:true")
    expect(screen.getByTestId("state-b").textContent).toBe("false:false")
  })

  it("opens the keyboard tab chooser and runs its numbered shortcut", () => {
    const open = vi.fn()
    render(
      <EditorGroups
        {...props(() => null)}
        layout={layout}
        launcherItems={[{ id: "terminal", label: "Terminal", icon: Plus, onSelect: open }]}
      />
    )
    fireEvent.keyDown(window, { key: "t", metaKey: true })
    expect(screen.getByTestId("new-tab-command-menu")).toBeTruthy()
    fireEvent.keyDown(window, { key: "1" })
    expect(open).toHaveBeenCalledOnce()
  })

  it("clears a drop preview when a drag is cancelled", () => {
    render(<EditorGroups {...props(() => null)} layout={layout} />)
    fireEvent.dragOver(screen.getAllByTestId("editor-group")[0]!, {
      clientX: 0,
      clientY: 0,
      dataTransfer: { types: [editorTabMime("session")], dropEffect: "move" }
    })
    expect(screen.getByTestId("editor-drop-overlay")).toBeTruthy()
    fireEvent.dragEnd(window)
    expect(screen.queryByTestId("editor-drop-overlay")).toBeNull()
  })

  it("shows a red rejection overlay and blocks files dropped onto a chat pane", () => {
    const onDrop = vi.fn()
    render(<EditorGroups {...props(() => null)} layout={layout} onDrop={onDrop} />)
    const mime = editorTabMime("session")
    const drag = { surface: source, from: "right" }
    const dataTransfer = {
      types: [mime, editorFileMime],
      dropEffect: "move",
      getData: (type: string) => type === mime ? JSON.stringify(drag) : ""
    }
    const chatPane = screen.getAllByTestId("editor-group")[0]!

    fireEvent.dragOver(chatPane, { dataTransfer })
    expect(screen.getByTestId("editor-drop-overlay").getAttribute("data-rejected")).toBe("true")
    expect(dataTransfer.dropEffect).toBe("none")
    fireEvent.drop(chatPane, { dataTransfer })

    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.queryByTestId("editor-drop-overlay")).toBeNull()
  })

  it.each([
    { surface: source, edge: "right", x: 95, y: 50, types: [editorTabMime("session"), editorFileMime] },
    { surface: view("terminal"), edge: "top", x: 50, y: 5, types: [editorTabMime("session")] }
  ] as const)("accepts a $surface.kind tab on the $edge split edge", ({ surface, edge, x, y, types }) => {
    const onDrop = vi.fn()
    render(<EditorGroups {...props(() => null)} layout={layout} onDrop={onDrop} />)
    const mime = editorTabMime("session")
    const drag = { surface, from: "right" }
    const dataTransfer = {
      types: [...types],
      dropEffect: "move",
      getData: (type: string) => type === mime ? JSON.stringify(drag) : ""
    }
    const target = screen.getAllByTestId("editor-group")[0]!
    target.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({})
    })

    const dragEvent = (type: "dragover" | "drop") => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        clientX: { value: x },
        clientY: { value: y },
        altKey: { value: false },
        dataTransfer: { value: dataTransfer }
      })
      fireEvent(target, event)
    }
    dragEvent("dragover")
    expect(screen.getByTestId("editor-drop-overlay").getAttribute("data-edge")).toBe(edge)
    expect(screen.getByTestId("editor-drop-overlay").getAttribute("data-rejected")).toBeNull()
    dragEvent("drop")

    expect(onDrop).toHaveBeenCalledWith(drag, "left", edge, false)
  })

  it("moves a split tab back into another group's tab strip even with Alt held", () => {
    const onDrop = vi.fn()
    render(<EditorGroups {...props(() => null)} layout={layout} onDrop={onDrop} />)
    const mime = editorTabMime("session")
    const drag = { surface: source, from: "left" }
    const dataTransfer = {
      types: [mime],
      dropEffect: "copy",
      getData: (type: string) => type === mime ? JSON.stringify(drag) : ""
    }

    fireEvent.dragOver(screen.getAllByTestId("editor-group")[1]!, { clientX: 0, clientY: 0, dataTransfer })
    fireEvent.dragOver(screen.getAllByTestId("editor-tab-strip")[1]!, { altKey: true, dataTransfer })
    expect(screen.getAllByTestId("editor-drop-overlay")).toHaveLength(1)
    fireEvent.drop(screen.getAllByTestId("editor-tab-strip")[1]!, { altKey: true, dataTransfer })

    expect(onDrop).toHaveBeenCalledOnce()
    expect(onDrop).toHaveBeenCalledWith(drag, "right", "center", false)
    expect(screen.queryByTestId("editor-drop-overlay")).toBeNull()
  })

  it("keeps a chat body mounted when the content pane opens and closes", () => {
    const mounted = vi.fn()
    const Body = ({ id }: { id: string }) => {
      useEffect(() => { mounted(id) }, [id])
      return <span>{id}</span>
    }
    const root = layout.root!
    const chatOnly: EditorLayout = { focusedGroupId: "left", root: root.type === "split" ? root.children[0]! : root }
    const view = render(<EditorGroups {...props((surface) => <Body id={surface.id} />)} layout={chatOnly} />)
    expect(mounted).toHaveBeenCalledTimes(2)

    view.rerender(<EditorGroups {...props((surface) => <Body id={surface.id} />)} layout={layout} />)
    expect(mounted.mock.calls.filter(([id]) => id === "a")).toHaveLength(1)
    expect(mounted.mock.calls.filter(([id]) => id === "b")).toHaveLength(1)

    view.rerender(<EditorGroups {...props((surface) => <Body id={surface.id} />)} layout={chatOnly} />)
    expect(mounted.mock.calls.filter(([id]) => id === "a")).toHaveLength(1)
  })

  it("tracks keyboard focus without focusing a group from its close button", () => {
    const onFocusGroup = vi.fn()
    render(<EditorGroups {...props(() => null)} layout={layout} onFocusGroup={onFocusGroup} />)
    fireEvent.focus(screen.getByRole("button", { name: "Close src/a.ts" }))
    expect(onFocusGroup).not.toHaveBeenCalled()
    fireEvent.focus(screen.getByRole("tab", { name: "src/a.ts" }))
    expect(onFocusGroup).toHaveBeenCalledWith("right")
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

    fireEvent.blur(window)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 600 })
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]?.slice(0, 2)).toEqual(["root", 0])
    expect(onResize.mock.calls[0]?.[2]).toBeCloseTo(0.1)
  })
})

it("offers checkpoints only on conversation surfaces and hands off the surviving trigger", async () => {
  const onOpenCheckpoints = vi.fn()
  const rendered = render(<EditorGroups {...props(() => null)} layout={layout} onOpenCheckpoints={onOpenCheckpoints} />)
  const trigger = screen.getByRole("button", { name: "More conversation actions" })
  expect(screen.queryByRole("button", { name: "Checkpoints" })).toBeNull()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const item = await screen.findByRole("menuitem", { name: "Checkpoints" })
  fireEvent.click(item)
  expect(onOpenCheckpoints).toHaveBeenCalledWith(trigger)
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Checkpoints" })).toBeNull())
  rendered.rerender(<EditorGroups {...props(() => null)} layout={{ focusedGroupId: "right", root: { type: "group", id: "right", tabs: [source], active: sessionSurfaceKey(source) } }} onOpenCheckpoints={onOpenCheckpoints} />)
  expect(screen.queryByRole("button", { name: "More conversation actions" })).toBeNull()
})
