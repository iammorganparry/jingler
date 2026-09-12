import { cleanup, render } from "@testing-library/react"
import { LoaderCircle } from "lucide-react"
import { afterEach, describe, expect, it } from "vitest"
import { Spin } from "./spin.js"

afterEach(cleanup)

describe("Spin", () => {
  it("puts the keyframes on an HTML wrapper, never on the svg", () => {
    // Blink runs transform animations on <svg> targets on the main thread;
    // the wrapper is the whole point of the component.
    const { container } = render(
      <Spin className="shrink-0">
        <LoaderCircle className="size-3" />
      </Spin>
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.tagName).toBe("SPAN")
    expect(wrapper?.className).toContain("animate-spin")
    expect(wrapper?.className).toContain("shrink-0")
    const svg = wrapper?.querySelector("svg")
    expect(svg?.getAttribute("class")).toContain("size-3")
    expect(svg?.getAttribute("class")).not.toContain("animate-")
  })

  it("keeps one element tree when inactive and selects the named keyframes", () => {
    const { container, rerender } = render(
      <Spin active={false} animation="breathe">
        <LoaderCircle />
      </Spin>
    )
    expect(container.firstElementChild?.className).not.toContain("animate-")
    rerender(
      <Spin animation="breathe">
        <LoaderCircle />
      </Spin>
    )
    expect(container.firstElementChild?.className).toContain("animate-breathe")
  })
})
