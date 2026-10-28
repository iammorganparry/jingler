import { describe, expect, it } from "vitest"
import { prEventMessage, stackedOnPr } from "./pr-events.js"

const prs = [{ number: 481 }, { number: 482 }]
const now = "2026-01-01T00:00:00.000Z"

describe("prEventMessage", () => {
  it("maps a stacked publish to Opened #N · stacked on #M", () => {
    const m = prEventMessage({ kind: "opened", number: 482, prs, now })
    expect(m.id).toBe("a_pr_opened_482")
    expect(m.parts).toEqual([{ _tag: "PrEvent", kind: "opened", number: 482, stackedOn: 481 }])
  })
  it("omits stackedOn for the bottom layer and for merges", () => {
    expect(prEventMessage({ kind: "opened", number: 481, prs, now }).parts[0]).not.toHaveProperty("stackedOn")
    expect(prEventMessage({ kind: "merged", number: 482, prs, now }).parts[0]).not.toHaveProperty("stackedOn")
  })
  it("stackedOnPr is undefined for unknown PRs", () => expect(stackedOnPr(prs, 9)).toBeUndefined())
})
