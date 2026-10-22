import { expect, it, vi } from "vitest"
import { requestSessionPr, stepFromShownPr } from "./session-pr-request.js"

it("steps from the chip-requested PR, not the machine's stale selection", () => {
  requestSessionPr("s1", 482)
  const calls: string[] = []
  const nav = { onSelect: vi.fn((n: number) => calls.push(`select ${n}`)), onStep: vi.fn((d: number) => calls.push(`step ${d}`)) }
  stepFromShownPr("s1", 482, nav, -1)
  expect(calls).toEqual(["select 482", "step -1"])
})
