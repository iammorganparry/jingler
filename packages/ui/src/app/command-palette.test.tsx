import * as React from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CommandPalette, PALETTE_PLACEHOLDER } from "./command-palette.js"
import type { PaletteItem } from "./command-palette-model.js"

afterEach(cleanup)

/**
 * Two jsdom gaps cmdk trips over, stubbed here rather than in a global setup
 * file: this is the only suite that mounts cmdk, and a shared shim would quietly
 * hand every other test a `ResizeObserver` that never fires — which is a
 * different lie from not having one. The app's own components already guard with
 * `typeof ResizeObserver === "undefined"` (see `use-container-width.ts`);
 * cmdk does not.
 */
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const item = (over: Partial<PaletteItem> & { id: string }): PaletteItem => ({
  kind: "action",
  label: over.label ?? over.id,
  group: over.group ?? "Actions",
  run: () => {},
  ...over
})

const ITEMS: ReadonlyArray<PaletteItem> = [
  {
    id: "session-1",
    kind: "session",
    label: "refactor auth",
    detail: "jingler · feat/auth",
    group: "Sessions",
    run: () => {}
  },
  {
    id: "session-2",
    kind: "session",
    label: "theme tokens",
    detail: "jingler · feat/theme",
    group: "Sessions",
    run: () => {}
  },
  item({ id: "new-session", label: "New Session", hint: "⌘N" }),
  item({ id: "open-settings", label: "Open Settings" })
]

const open = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) =>
  render(
    <CommandPalette open onOpenChange={() => {}} items={ITEMS} {...props} />
  )

const input = () => screen.getByPlaceholderText(PALETTE_PLACEHOLDER)

describe("CommandPalette", () => {
  it("renders every item under its own heading", () => {
    open()
    expect(screen.getByText("Sessions")).toBeTruthy()
    expect(screen.getByText("Actions")).toBeTruthy()
    expect(screen.getByText("refactor auth")).toBeTruthy()
    expect(screen.getByText("New Session")).toBeTruthy()
  })

  it("renders nothing at all when closed", () => {
    render(<CommandPalette open={false} onOpenChange={() => {}} items={ITEMS} />)
    expect(screen.queryByPlaceholderText(PALETTE_PLACEHOLDER)).toBeNull()
  })

  it("puts the caret in the input on open, so you can type immediately", async () => {
    open()
    await waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it("filters on an abbreviation a substring match would miss", async () => {
    open()
    fireEvent.change(input(), { target: { value: "tht" } })
    // "t-h-t" is a subsequence of "theme tokens" but not a substring of it.
    await waitFor(() => expect(screen.queryByText("refactor auth")).toBeNull())
    expect(screen.getByText("theme tokens")).toBeTruthy()
  })

  it("shows the empty message rather than an empty box", async () => {
    open()
    fireEvent.change(input(), { target: { value: "zzzzzzz" } })
    await waitFor(() => expect(screen.getByText("No matching commands")).toBeTruthy())
    expect(screen.queryByText("refactor auth")).toBeNull()
  })

  it("does not search the row's id, which would float unrelated rows", async () => {
    open()
    // "session-1" is the id of "refactor auth"; typing it must not resurrect it.
    fireEvent.change(input(), { target: { value: "session-1" } })
    await waitFor(() => expect(screen.queryByText("refactor auth")).toBeNull())
  })

  it("runs the item on Enter", async () => {
    const run = vi.fn()
    open({ items: [item({ id: "only", label: "Only", run })] })
    fireEvent.keyDown(input(), { key: "Enter" })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  })

  it("closes BEFORE running, so an action's own dialog is not trapped behind it", async () => {
    const order: string[] = []
    const onOpenChange = vi.fn(() => order.push("close"))
    open({
      onOpenChange,
      items: [item({ id: "only", label: "Only", run: () => order.push("run") })]
    })
    fireEvent.keyDown(input(), { key: "Enter" })
    await waitFor(() => expect(order).toEqual(["close", "run"]))
  })

  it("does nothing on Enter when the query matches nothing", async () => {
    const run = vi.fn()
    const onOpenChange = vi.fn()
    open({ onOpenChange, items: [item({ id: "only", label: "Only", run })] })
    fireEvent.change(input(), { target: { value: "zzzzzzz" } })
    await waitFor(() => expect(screen.getByText("No matching commands")).toBeTruthy())
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(run).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("moves the selection with the arrow keys", async () => {
    open()
    const first = screen.getByTestId("palette-item-session-1")
    await waitFor(() => expect(first.getAttribute("data-selected")).toBe("true"))
    fireEvent.keyDown(input(), { key: "ArrowDown" })
    await waitFor(() =>
      expect(screen.getByTestId("palette-item-session-2").getAttribute("data-selected")).toBe(
        "true"
      )
    )
  })

  it("clears the query when it closes, so reopening is a fresh search", async () => {
    const { rerender } = render(
      <CommandPalette open onOpenChange={() => {}} items={ITEMS} />
    )
    fireEvent.change(input(), { target: { value: "theme" } })
    await waitFor(() => expect(screen.queryByText("refactor auth")).toBeNull())

    rerender(<CommandPalette open={false} onOpenChange={() => {}} items={ITEMS} />)
    rerender(<CommandPalette open onOpenChange={() => {}} items={ITEMS} />)

    await waitFor(() => expect(input()).toHaveProperty("value", ""))
    expect(screen.getByText("refactor auth")).toBeTruthy()
  })

  it("shows a hint chord when the item has one", () => {
    open()
    expect(screen.getByText("⌘N")).toBeTruthy()
  })
})
