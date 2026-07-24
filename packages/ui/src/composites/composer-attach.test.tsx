import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

/**
 * Attachments in Gigaplan.
 *
 * These used to be REFUSED, because `Plan.adversarial` carried a brief and
 * nothing else: an image accepted here would render into the transcript and be
 * dropped on the way to the round, which reads to the operator as "the planner
 * saw my screenshot" when it never did.
 *
 * The payload now carries `images` and hands them to every role's `SessionSpec`,
 * so the honest behaviour flipped: accepting is correct, and a briefing that is
 * half screenshot is exactly the case Gigaplan is for. These tests hold the new
 * contract, and specifically that the control is not special-cased by mode —
 * the old guard lived in three places (button, `addFiles`, the "+" tile) and any
 * one left behind silently loses the attachment.
 */
afterEach(cleanup)

const IMAGES_NOT_SENT = /images aren't sent/i

const attachmentItem = () => {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Composer menu" }), {
    button: 0,
    ctrlKey: false
  })
  return screen.getByRole("menuitem", { name: "Add image" })
}

describe("Composer attachments in Gigaplan", () => {
  it("allows attaching — the round carries images now", () => {
    render(<Composer mode="gigaplan" />)
    expect(attachmentItem().getAttribute("data-disabled")).toBeNull()
  })

  it("keeps one stable accessible name, so it can't answer to another control's", () => {
    // Regression: the explanation used to BE the name, which made this button
    // match a by-name lookup for the Gigaplan mode chip.
    render(<Composer mode="gigaplan" />)
    expect(attachmentItem()).toBeTruthy()
  })

  it("says the same thing it says everywhere else — no mode-specific excuse", () => {
    render(<Composer mode="gigaplan" />)
    expect(attachmentItem()).toBeTruthy()
    expect(screen.queryByTitle(IMAGES_NOT_SENT)).toBe(null)
  })

  it("leaves every other mode alone", () => {
    render(<Composer mode="accept-edits" />)
    expect(attachmentItem().getAttribute("data-disabled")).toBeNull()
  })

  it("labels Codex ask mode by its safe read-only behaviour", () => {
    render(<Composer cli="codex" mode="ask" />)
    expect(screen.getByText("read only")).toBeTruthy()
    expect(screen.queryByText("ask")).toBe(null)
  })
})
