import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { ReadingActionsMenu, ReadingShell } from "./reading-shell.js"

afterEach(cleanup)

describe("ReadingShell", () => {
  it("renders the title with a grey identifier, meta line, actions and body in a 720px column", () => {
    render(
      <ReadingShell title="Fix auth" identifier="#42" meta={<span>meta</span>} actions={<button type="button">Act</button>}>
        <p>body</p>
      </ReadingShell>
    )
    const heading = screen.getByRole("heading", { name: "Fix auth #42" })
    expect(heading.querySelector("span")?.className).toContain("text-dim")
    expect(screen.getByTestId("reading-column").className).toContain("max-w-[720px]")
    expect(screen.getByTestId("reading-header").textContent).toContain("meta")
    expect(screen.getByRole("button", { name: "Act" })).toBeTruthy()
    expect(screen.getByText("body")).toBeTruthy()
    expect(screen.queryByTestId("reading-rail")).toBeNull()
  })

  it("docks a 280px rail at the wide tier and stacks it below", () => {
    const at = (tier: "wide" | "narrow") =>
      render(
        <WidthTierValue width={tier === "wide" ? 1000 : 450}>
          <ReadingShell title="T" rail={<span>rail</span>} />
        </WidthTierValue>
      )
    at("wide")
    expect(screen.getByTestId("reading-rail").className).toContain("w-[280px]")
    cleanup()
    at("narrow")
    expect(screen.getByTestId("reading-rail").className).toContain("w-full")
  })
})

describe("ReadingActionsMenu", () => {
  it("renders nothing without items", () => {
    const { container } = render(<ReadingActionsMenu items={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("selects an item and marks destructive ones", async () => {
    const onSelect = vi.fn()
    render(<ReadingActionsMenu items={[{ label: "Copy link", onSelect: () => {} }, { label: "Close issue", onSelect, destructive: true }]} />)
    await userEvent.click(screen.getByRole("button", { name: "More actions" }))
    const close = screen.getByRole("menuitem", { name: "Close issue" })
    expect(close.className).toContain("text-state-failed")
    expect(screen.getByRole("menuitem", { name: "Copy link" }).className).not.toContain("text-state-failed")
    await userEvent.click(close)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
