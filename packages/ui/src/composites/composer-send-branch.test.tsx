import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

/**
 * The toolbar's trailing end: the branch label and the send/stop control.
 *
 * Both changed shape at once — the branch moved from leading the row to riding
 * beside send, and send/stop lost their text for icons. The pairing is the
 * point (destination next to the action that uses it), and an icon-only button
 * has no visible text to fall back on, so its `aria-label` is now the ONLY name
 * anything — screen reader, test, e2e spec — can find it by.
 */

afterEach(cleanup)

/** Bars the glyph is filling, i.e. rungs on the provider's reasoning ladder. */
const filledBars = (chip: HTMLElement) =>
  [...chip.querySelectorAll("rect")].filter((r) => r.getAttribute("opacity") === "1").length

describe("Composer send row", () => {
  it("puts the branch immediately before the send button", () => {
    render(<Composer branch="starbase/wandering-watt" />)
    const branch = screen.getByTitle("Working branch: starbase/wandering-watt")
    const send = screen.getByRole("button", { name: /Send/ })
    // FOLLOWING, not merely "somewhere later": the branch used to lead the row,
    // and any assertion loose enough to pass in both places tests nothing.
    expect(branch.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
