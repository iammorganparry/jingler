import type { ProviderId } from "@jingler/core"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ProviderIcon } from "./provider-icon.js"

afterEach(cleanup)

const id = (value: string) => value as ProviderId

describe("ProviderIcon", () => {
  it("renders the real Claude and Codex marks at 14px", () => {
    for (const providerId of ["anthropic", "openai-codex"]) {
      const { container } = render(<ProviderIcon providerId={id(providerId)} />)
      const svg = container.querySelector("svg")!
      expect(svg.getAttribute("width")).toBe("14")
      expect(svg.getAttribute("height")).toBe("14")
      expect(container.querySelector("[data-provider-fallback]")).toBeNull()
      cleanup()
    }
  })

  it("falls back to a neutral letter tile for providers without a mark", () => {
    const { container } = render(<ProviderIcon providerId={id("google")} />)
    const tile = container.querySelector<HTMLElement>("[data-provider-fallback]")!
    expect(tile.textContent).toBe("g")
    expect(tile.style.width).toBe("14px")
    expect(container.querySelector("svg")).toBeNull()
  })
})
