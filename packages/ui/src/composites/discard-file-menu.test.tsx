import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiscardFileMenu } from "./discard-file-menu.js"

afterEach(cleanup)

const view = (onDiscard = vi.fn()) =>
  render(
    <DiscardFileMenu paths={new Set(["src/a.ts"])} onDiscard={onDiscard}>
      <div>
        <div data-item-path="src/a.ts">a.ts</div>
        <div data-item-path="src/b.ts">b.ts</div>
        <div data-item-path="src">src</div>
      </div>
    </DiscardFileMenu>
  )

describe("DiscardFileMenu", () => {
  it("confirms before discarding the right-clicked file", async () => {
    const onDiscard = vi.fn()
    view(onDiscard)

    fireEvent.contextMenu(screen.getByText("a.ts"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard file changes" }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(await screen.findByText("Discard changes to a.ts?")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await vi.waitFor(() => expect(onDiscard).toHaveBeenCalledExactlyOnceWith("src/a.ts"))
  })

  it("does not discard when the confirmation is cancelled", async () => {
    const onDiscard = vi.fn()
    view(onDiscard)

    fireEvent.contextMenu(screen.getByText("a.ts"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard file changes" }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(onDiscard).not.toHaveBeenCalled()
  })

  it("opens no menu on folders or files with nothing to discard", () => {
    view()

    fireEvent.contextMenu(screen.getByText("b.ts"))
    fireEvent.contextMenu(screen.getByText("src"))

    expect(screen.queryByRole("menuitem", { name: "Discard file changes" })).toBeNull()
  })
})
