import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DiffView, type DiffActions } from "./diff-view.js"

const path = "src/sample.ts"
const patch = [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1,3 +1,4 @@",
  "-const first = oldValue",
  "+const first = nextValue",
  "+const second = addedValue",
  " export { first }",
  ""
].join("\n")

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const gutter = async (
  line: number,
  type: "change-addition" | "change-deletion"
): Promise<HTMLElement> => {
  const container = await waitFor(() => {
    const element = document.querySelector("diffs-container")
    expect(element?.shadowRoot).toBeTruthy()
    return element!
  })
  return waitFor(() => {
    const element = container.shadowRoot?.querySelector<HTMLElement>(
      `[data-line-type="${type}"][data-column-number="${line}"]`
    )
    expect(element).toBeTruthy()
    return element!
  })
}

const select = (element: HTMLElement, shiftKey = false): void => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 10,
    clientY: 10,
    shiftKey
  })
  fireEvent.pointerUp(document, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 10,
    clientY: 10,
    shiftKey
  })
}

describe("DiffView Pierre selection", () => {
  it("uses Pierre click and Shift-selection, renders actions as an annotation, and clears them", async () => {
    const actions: DiffActions = {
      onRevertLines: vi.fn(),
      onRevertFile: vi.fn(),
      onComment: vi.fn()
    }
    render(<DiffView patch={patch} fill={false} actions={actions} />)

    select(await gutter(1, "change-addition"))
    expect(await screen.findByText("sample.ts new L1")).toBeTruthy()

    select(await gutter(2, "change-addition"), true)
    expect(await screen.findByText("sample.ts new L1–new L2")).toBeTruthy()
    const annotation = document.querySelector(
      '[data-jingler-pierre-annotation="selected-range-actions"]'
    )
    expect(annotation).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Cancel selected range" }))
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Ask the agent to fix this…")).toBeNull()
    )

    select(await gutter(1, "change-deletion"))
    fireEvent.click(screen.getByRole("button", { name: "Revert" }))
    expect(actions.onRevertLines).toHaveBeenCalledExactlyOnceWith({
      path,
      side: "old",
      startLine: 1,
      endLine: 1,
      endSide: "old"
    })
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Ask the agent to fix this…")).toBeNull()
    )

    select(await gutter(1, "change-addition"))
    const body = await screen.findByPlaceholderText("Ask the agent to fix this…")
    fireEvent.change(body, { target: { value: "Use the validated value." } })
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }))
    expect(actions.onComment).toHaveBeenCalledExactlyOnceWith(
      {
        path,
        side: "new",
        startLine: 1,
        endLine: 1,
        endSide: "new"
      },
      "Use the validated value."
    )
    await waitFor(() => expect(screen.queryByText("sample.ts new L1")).toBeNull())
  })

  it("keeps whole-file actions accessible independently of line selection", () => {
    const actions: DiffActions = {
      onRevertLines: vi.fn(),
      onRevertFile: vi.fn(),
      onComment: vi.fn()
    }
    render(<DiffView patch={patch} fill={false} actions={actions} />)

    fireEvent.click(screen.getByRole("button", { name: `Revert ${path}` }))
    expect(actions.onRevertFile).toHaveBeenCalledExactlyOnceWith(path)
    expect(screen.getByRole("toolbar", { name: "File diff actions" })).toBeTruthy()
  })

  it("updates live content without remounting the viewer and clears stale selection", async () => {
    const actions: DiffActions = {
      onRevertLines: vi.fn(),
      onRevertFile: vi.fn(),
      onComment: vi.fn()
    }
    const rendered = render(<DiffView patch={patch} fill={false} actions={actions} />)
    const original = await waitFor(() => {
      const element = document.querySelector("diffs-container")
      expect(element).toBeTruthy()
      return element
    })
    select(await gutter(1, "change-addition"))
    expect(await screen.findByText("sample.ts new L1")).toBeTruthy()

    rendered.rerender(
      <DiffView
        patch={patch.replace("nextValue", "newestValue")}
        fill={false}
        actions={actions}
      />
    )

    await waitFor(() => expect(screen.queryByText("sample.ts new L1")).toBeNull())
    expect(document.querySelector("diffs-container")).toBe(original)
  })
})
