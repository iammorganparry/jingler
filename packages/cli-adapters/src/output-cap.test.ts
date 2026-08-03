import { describe, expect, it } from "vitest"
import { capOutput, makeCappedAccumulator, OUTPUT_CAP } from "./output-cap.js"

describe("makeCappedAccumulator", () => {
  it("reconstructs the exact text below the cap", () => {
    const acc = makeCappedAccumulator()
    acc.append("RUN\n")
    acc.append("PASS\n")
    expect(acc.snapshot()).toBe("RUN\nPASS\n")
  })

  it("matches capOutput for a single push above the cap", () => {
    const text = "x".repeat(OUTPUT_CAP * 3)
    const acc = makeCappedAccumulator()
    acc.append(text)
    expect(acc.snapshot()).toBe(capOutput(text))
  })

  it("matches capOutput for the concatenation of many pushes", () => {
    const chunks = Array.from({ length: 500 }, (_, i) => `line-${i}-${"y".repeat(50)}\n`)
    const acc = makeCappedAccumulator()
    for (const chunk of chunks) acc.append(chunk)
    expect(acc.snapshot()).toBe(capOutput(chunks.join("")))
  })

  it("retains only O(cap) regardless of total output", () => {
    const acc = makeCappedAccumulator()
    // 200 MB streamed as 1 MB chunks — must not retain the raw concatenation.
    for (let i = 0; i < 200; i++) acc.append("z".repeat(1024 * 1024))
    const snapshot = acc.snapshot()
    expect(snapshot.length).toBeLessThan(OUTPUT_CAP + 100)
    expect(snapshot).toContain("characters omitted")
  })
})
