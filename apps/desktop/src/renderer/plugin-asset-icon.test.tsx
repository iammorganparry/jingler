// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPluginAssetIcon } from "./plugin-asset-icon.js"

interface PendingImage {
  onload: (() => void) | null
  onerror: (() => void) | null
  src: string
}

let images: PendingImage[]

beforeEach(() => {
  images = []
  vi.stubGlobal(
    "Image",
    class implements PendingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      src = ""

      constructor() {
        images.push(this)
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("plugin asset icon", () => {
  it("renders a current-colour mask after the local SVG loads", async () => {
    const src = "jingler-plugin://linear/dist/assets/linear-mark.svg?v=1.0.0"
    const Icon = createPluginAssetIcon(src)
    const view = render(<Icon className="text-blue" size={16} />)

    expect(view.container.querySelector('[data-plugin-asset-icon="fallback"]')).toBeTruthy()
    await waitFor(() => expect(images).toHaveLength(1))
    act(() => images[0]?.onload?.())
    await waitFor(() =>
      expect(view.container.querySelector('[data-plugin-asset-icon="ready"]')).toBeTruthy()
    )

    const rect = view.container.querySelector("rect") as SVGRectElement
    expect(rect.getAttribute("fill")).toBe("currentColor")
    expect(rect.getAttribute("style")).toContain(src)
  })

  it("keeps the standard glyph when the asset is missing", async () => {
    const Icon = createPluginAssetIcon(
      "jingler-plugin://linear/dist/assets/missing.svg?v=1.0.1"
    )
    const view = render(<Icon />)

    await waitFor(() => expect(images).toHaveLength(1))
    act(() => images[0]?.onerror?.())
    await waitFor(() =>
      expect(view.container.querySelector('[data-plugin-asset-icon="fallback"]')).toBeTruthy()
    )
    expect(view.container.querySelector('[data-plugin-asset-icon="ready"]')).toBeNull()
  })
})
