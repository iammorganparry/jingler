import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(import.meta.dirname, "globals.css"), "utf8")

describe("type scale and radius tokens (spec §2)", () => {
  it.each([11, 12, 13, 15, 20])("defines text-scale-%i and scales it with --sb-font-scale", (size) => {
    expect(css).toContain(`--text-scale-${size}: calc(${size}px * var(--sb-font-scale, 1));`)
  })

  it("defines the 6/8/12 radii without changing the legacy radii", () => {
    expect(css).toContain("--radius-chip: 6px;")
    expect(css).toContain("--radius-input: 8px;")
    expect(css).toContain("--radius-card: 12px;")
    expect(css).toContain("--radius-lg: 5px;")
    expect(css).toContain("--radius-xl: 7px;")
  })
})
