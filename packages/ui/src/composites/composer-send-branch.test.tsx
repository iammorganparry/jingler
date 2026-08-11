import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { testProviderCatalog } from "../test-support.js"
import { Composer } from "./composer.js"

/**
 * The composer's trailing controls and its lower metadata row.
 *
 * The branch label rides the LOWER metadata row now — bottom-right, beside the
 * repository — not the toolbar beside send, so a long branch name never competes
 * with the pickers for toolbar width. Send/stop are icon-only, so an
 * `aria-label` is the ONLY name anything — screen reader, test, e2e spec — can
 * find them by.
 */

afterEach(cleanup)

/** Bars the glyph is filling, i.e. rungs on the provider's reasoning ladder. */
const filledBars = (chip: HTMLElement) =>
  [...chip.querySelectorAll("rect")].filter((r) => r.getAttribute("opacity") === "1").length

const catalog = testProviderCatalog(["low", "medium", "high", "xhigh"])
const { id: connectionId } = catalog.connections[0]!.connection
const { id: modelId } = catalog.connections[0]!.models[0]!

describe("Composer send row", () => {
  it("replaces the pending branch label as soon as the session branch settles", () => {
    const { rerender } = render(
      <Composer branch="main" branchPending repo="widget" />
    )

    const branch = () => screen.getByTestId("composer-branch")
    expect(branch().textContent).toBe("Naming branch…")
    expect(branch().getAttribute("aria-live")).toBe("polite")

    rerender(
      <Composer branch="fix/linear-session-styles" branchPending={false} repo="widget" />
    )

    expect(branch().textContent).toBe("fix/linear-session-styles")
    expect(branch().getAttribute("title")).toBe(
      "Working branch: fix/linear-session-styles"
    )
  })

  it("puts the branch on the lower row, after send and to the right of the repo", () => {
    render(<Composer branch="chore/wandering-watt" repo="widget" />)
    const branch = screen.getByTitle("Working branch: chore/wandering-watt")
    const send = screen.getByRole("button", { name: /Send/ })
    const repo = screen.getByTitle("Repository: widget")
    // The branch left the toolbar for the lower metadata row, so it now FOLLOWS
    // the send button in DOM order — and sits after the repo on that row, which
    // `justify-between` renders bottom-right. FOLLOWING, not merely "somewhere
    // later": an assertion loose enough to pass with the old order tests nothing.
    expect(send.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(repo.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("sends and stops through icon-only buttons named by their label", () => {
    const { rerender } = render(<Composer onStop={() => {}} />)
    expect(screen.getByRole("button", { name: /Send/ }).textContent).toBe("")

    rerender(<Composer busy onStop={() => {}} />)
    expect(screen.getByRole("button", { name: /^Stop$/ }).textContent).toBe("")
  })

  it("uses Paseo's softer shell without an outer glow and keeps send compact", () => {
    render(<Composer />)
    const composer = screen.getByTestId("composer")
    const surface = composer.firstElementChild as HTMLElement
    const send = screen.getByRole("button", { name: /Send/ })

    expect(surface.className).toContain("rounded-2xl")
    expect(surface.className).toContain("border-line")
    expect(surface.className).not.toMatch(/border-(blue|green|orange|purple)/)
    expect(surface.className).not.toMatch(/shadow-\[0_0/)
    expect(send.className).toContain("size-7")
    expect(send.className).toContain("rounded-full")
  })

  it("fills one bar per rung of the selected model's reasoning ladder", () => {
    render(<Composer providerCatalog={catalog} connectionId={connectionId} modelId={modelId} reasoningEffort="high" />)
    const chip = () => screen.getByRole("button", { name: "Thinking strength" })
    expect(filledBars(chip())).toBe(3)
  })

  it("fills nothing for the provider default or for thinking turned off", () => {
    const { rerender } = render(<Composer />)
    const chip = () => screen.getByRole("button", { name: "Thinking strength" })
    expect(filledBars(chip())).toBe(0)

    // `off` is told apart from `default` by the slash, not by a bar count —
    // neither is a strength, so neither may claim a rung.
    rerender(<Composer thinkingEnabled={false} />)
    expect(filledBars(chip())).toBe(0)
    expect(chip().querySelector("line")).toBeTruthy()
    rerender(<Composer />)
    expect(chip().querySelector("line")).toBeNull()
  })
})
