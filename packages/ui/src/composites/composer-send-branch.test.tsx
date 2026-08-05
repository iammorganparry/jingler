import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
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

describe("Composer send row", () => {
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

  it("fills one bar per rung of the harness's own reasoning ladder", () => {
    // Claude's ladder is low · medium · high · xhigh · max, so "high" is 3 of 5.
    const { rerender } = render(<Composer cli="claude" reasoningEffort="high" />)
    const chip = () => screen.getByRole("button", { name: "Thinking strength" })
    expect(filledBars(chip())).toBe(3)

    // Codex leads with "minimal", so the same word sits a rung higher there —
    // the glyph follows the list the operator is picking from, not a fixed scale.
    rerender(<Composer cli="codex" reasoningEffort="high" />)
    expect(filledBars(chip())).toBe(4)
  })

  it("fills nothing for the harness default or for thinking turned off", () => {
    const { rerender } = render(<Composer cli="claude" />)
    const chip = () => screen.getByRole("button", { name: "Thinking strength" })
    expect(filledBars(chip())).toBe(0)

    // `off` is told apart from `default` by the slash, not by a bar count —
    // neither is a strength, so neither may claim a rung.
    rerender(<Composer cli="claude" thinkingEnabled={false} />)
    expect(filledBars(chip())).toBe(0)
    expect(chip().querySelector("line")).toBeTruthy()
    rerender(<Composer cli="claude" />)
    expect(chip().querySelector("line")).toBeNull()
  })
})
