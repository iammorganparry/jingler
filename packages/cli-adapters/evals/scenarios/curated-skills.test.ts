import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../../..")
const skill = (name: string) => readFile(resolve(root, "skills", name, "SKILL.md"), "utf8")

describe("curated skill behavior", () => {
  it("adds security evidence and scanner boundaries absent from the baseline prompt", async () => {
    const text = await skill("security-review")
    expect(text).toContain("trust boundary")
    expect(text).toContain("security_scan")
    expect(text).toContain("Never treat a clean scanner as proof")
  })

  it("adds Electron process tracing and behavioral E2E requirements", async () => {
    const text = await skill("electron-e2e")
    expect(text).toContain("main process through preload and renderer")
    expect(text).toContain("Electron E2E test")
    expect(text).toContain("keyboard/accessibility")
  })
})
