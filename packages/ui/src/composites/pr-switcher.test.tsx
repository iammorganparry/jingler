import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PrStackNav } from "./pr-stack-rail.js"
import { matchStackStepChord, PrSwitcher } from "./pr-switcher.js"

afterEach(cleanup)

const nav = (over: Partial<PrStackNav> = {}): PrStackNav => ({
  layers: [
    { number: 480, branch: "stack/model", state: "merged" },
    { number: 481, branch: "stack/api", state: "open" },
    { number: 482, branch: "stack/ui", state: "open" }
  ],
  selected: 481,
  onSelect: () => {},
  onStep: () => {},
  ...over
})

describe("PrSwitcher", () => {
  it("shows the selected PR and its 1-based position", () => {
    render(<PrSwitcher {...nav()} />)
    const trigger = screen.getByTestId("pr-switcher")
    expect(trigger.textContent).toContain("PR #481")
    expect(trigger.textContent).toContain("2/3")
  })

  it("steps down on ⌥[ and up on ⌥]", () => {
    const onStep = vi.fn()
    render(<PrSwitcher {...nav({ onStep })} />)
    fireEvent.keyDown(window, { code: "BracketLeft", altKey: true })
    fireEvent.keyDown(window, { code: "BracketRight", altKey: true })
    fireEvent.keyDown(window, { code: "BracketRight" })
    expect(onStep.mock.calls).toEqual([[-1], [1]])
  })
})

describe("matchStackStepChord", () => {
  it("ignores chords with other modifiers", () => {
    expect(matchStackStepChord({ code: "BracketRight", altKey: true, metaKey: true, ctrlKey: false, shiftKey: false })).toBeNull()
    expect(matchStackStepChord({ code: "BracketRight", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false })).toBe(1)
  })
})
