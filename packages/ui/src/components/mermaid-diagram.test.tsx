// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MermaidDiagram } from "./mermaid-diagram.js"

// mermaid is heavy and needs real layout APIs jsdom lacks, so we mock the module
// the component dynamically imports and drive success/failure from the test.
const render_ = vi.fn()
const initialize = vi.fn()
vi.mock("mermaid", () => ({ default: { initialize: (...a: unknown[]) => initialize(...a), render: (...a: unknown[]) => render_(...a) } }))

afterEach(() => {
  cleanup()
  render_.mockReset()
  initialize.mockReset()
})

describe("MermaidDiagram", () => {
  it("renders the sanitized SVG returned by mermaid", async () => {
    render_.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' })
    render(<MermaidDiagram source="graph TD; A-->B" />)
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeTruthy())
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false })
    )
  })

  it("shows an inline error card when the diagram is invalid, without throwing", async () => {
    render_.mockRejectedValue(new Error("Parse error on line 1"))
    render(<MermaidDiagram source="not a diagram" />)
    await waitFor(() => expect(screen.getByText("Diagram error")).toBeTruthy())
    expect(screen.getByText(/Parse error on line 1/)).toBeTruthy()
    // The error is contained: no SVG was injected.
    expect(document.querySelector("svg")).toBeNull()
  })

  it("renders nothing to mermaid for an empty fence", () => {
    render(<MermaidDiagram source="   " />)
    expect(render_).not.toHaveBeenCalled()
  })
})
