import { describe, expect, it } from "vitest"
import { commandLineCount, commandSummary } from "./command-summary.js"

describe("commandLineCount", () => {
  it("counts lines in a multi-line command", () => {
    expect(commandLineCount("one\ntwo\nthree")).toBe(3)
  })

  it("is 1 for a single-line command", () => {
    expect(commandLineCount("pnpm test")).toBe(1)
  })
})

describe("commandSummary", () => {
  it("summarises a short command as one line", () => {
    expect(commandSummary("pnpm test --filter @jingler/ui")).toBe("Run pnpm test --filter @jingler/ui")
  })

  it("uses only the first line of a multi-line command", () => {
    expect(commandSummary("pnpm test\nsecond line")).toBe("Run pnpm test")
  })

  it("truncates a long first line to ~60 chars with an ellipsis", () => {
    const long = "pnpm --filter @jingler/desktop exec playwright test e2e/changes-review.spec.ts --project=electron"
    const summary = commandSummary(long)
    expect(summary.startsWith("Run pnpm --filter @jingler/desktop exec playwright test")).toBe(true)
    expect(summary).toContain("…")
    expect(summary.length).toBeLessThanOrEqual(65)
  })

  it("normalises internal whitespace", () => {
    expect(commandSummary("pnpm   test    now")).toBe("Run pnpm test now")
  })
})
