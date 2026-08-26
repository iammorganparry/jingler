import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8")

describe("BeUI production ownership", () => {
  it("keeps compatibility atoms backed by BeUI implementations", () => {
    expect(source("../button.tsx")).toContain('from "motion/react"')
    expect(source("../button.tsx")).toContain("rounded-lg")
    expect(source("../input.tsx")).toContain("BeUI Input")
    expect(source("../checkbox.tsx")).toContain('from "motion/react"')
    expect(source("../toggle.tsx")).toContain("THUMB_SPRING")
    expect(source("../segmented-control.tsx")).toContain('from "./beui/controls.js"')
    expect(source("../loading.tsx")).toContain('from "./beui/loader.js"')
    expect(source("../badge.tsx")).toContain('from "./beui/animated-badge.js"')
    expect(source("../tooltip.tsx")).toContain('from "./beui/tooltip.js"')
    expect(source("../chip-menu.tsx")).toContain('from "./beui/popover-morph.js"')
    expect(source("../dialog.tsx")).toContain("clipPath")
  })

  it("does not restore unused BeUI or superseded legacy atoms", () => {
    for (const relative of [
      "../popover.tsx",
      "../dropdown-menu.tsx",
      "./visual.tsx",
      "./combobox.tsx",
      "./combobox/context.tsx"
    ]) expect(existsSync(new URL(relative, import.meta.url))).toBe(false)

    expect(source("./controls.tsx")).not.toContain("MotionButton")
    expect(source("./feedback.tsx")).not.toContain("Marquee")
    expect(source("./overlays.tsx")).not.toContain("BottomSheet")
  })
})
