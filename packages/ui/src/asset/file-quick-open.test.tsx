import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FileQuickOpen } from "./file-quick-open.js"

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(cleanup)

const entries = [
  { path: "src/file-browser-machine.ts", status: "modified" as const },
  { path: "docs/file-browser-notes.md", status: "clean" as const },
  { path: "packages/ui/src/button.tsx", status: "clean" as const }
]

describe("FileQuickOpen", () => {
  it("fuzzy-ranks focused-session paths and opens the keyboard selection", async () => {
    const onOpenPath = vi.fn()
    render(
      <FileQuickOpen
        open
        onOpenChange={() => {}}
        entries={entries}
        sessionTitle="File browser"
        onOpenPath={onOpenPath}
      />
    )

    const input = screen.getByPlaceholderText("Open a file in File browser…")
    fireEvent.change(input, { target: { value: "fbma" } })
    await waitFor(() => {
      expect(screen.getByText("file-browser-machine.ts")).toBeTruthy()
      expect(screen.queryByText("button.tsx")).toBeNull()
    })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(onOpenPath).toHaveBeenCalledWith("src/file-browser-machine.ts")
    )
  })

  it("uses arrow keys to choose among matching files", async () => {
    const onOpenPath = vi.fn()
    render(
      <FileQuickOpen
        open
        onOpenChange={() => {}}
        entries={entries}
        onOpenPath={onOpenPath}
      />
    )
    const input = screen.getByPlaceholderText("Open a file in the focused session…")
    fireEvent.change(input, { target: { value: "fb" } })
    await waitFor(() => {
      expect(screen.getByText("file-browser-machine.ts")).toBeTruthy()
      expect(screen.getByText("file-browser-notes.md")).toBeTruthy()
    })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(onOpenPath).toHaveBeenCalledWith("src/file-browser-machine.ts")
    )
  })

  it("reports tree loading instead of claiming there are no files", () => {
    render(
      <FileQuickOpen
        open
        onOpenChange={() => {}}
        entries={[]}
        loading
        onOpenPath={() => {}}
      />
    )
    expect(screen.getByText("Loading repository files…")).toBeTruthy()
  })
})
