// @vitest-environment jsdom
import { jinglerDark, toTokens } from "@jingler/themes"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAssetProvider } from "../asset/open-asset-context.js"
import { ThemeProvider } from "../theme-provider.js"
import { PlanChangeBlock } from "./plan-change-block.js"

const noop = class { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", noop)
  vi.stubGlobal("IntersectionObserver", noop)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderBlock = (path: string, patch: string, known = new Set<string>(), open = vi.fn()) =>
  render(
    <ThemeProvider tokens={toTokens(jinglerDark)}>
      <OpenAssetProvider open={open} knownFiles={known}>
        <PlanChangeBlock path={path} patch={patch} />
      </OpenAssetProvider>
    </ThemeProvider>
  )

describe("PlanChangeBlock", () => {
  it("renders a Pierre diff and links a tracked path to Files", () => {
    const open = vi.fn()
    renderBlock("src/a.ts", "@@ -1 +1 @@\n-a\n+b", new Set(["src/a.ts"]), open)
    expect(screen.getByRole("region", { name: "Proposed change to src/a.ts" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts" }))
    expect(open).toHaveBeenCalledWith("src/a.ts")
  })

  it("shows an untracked path as plain text, not a dead link", () => {
    renderBlock("src/new-file.ts", "@@ -0,0 +1 @@\n+export {}")
    expect(screen.queryByRole("button", { name: "Open src/new-file.ts" })).toBeNull()
    expect(screen.getByText("src/new-file.ts")).toBeTruthy()
  })

  it("falls back to the raw text when the patch has no diff content", () => {
    renderBlock("src/a.ts", "\n\n")
    expect(screen.queryByRole("region", { name: "Proposed change to src/a.ts" })).toBeNull()
    expect(document.querySelector("figure pre")).toBeTruthy()
  })
})
