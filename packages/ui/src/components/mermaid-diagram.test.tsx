// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenAssetProvider } from "../asset/open-asset-context.js"
import { MermaidDiagram, parseLinkDirectives } from "./mermaid-diagram.js"

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

describe("parseLinkDirectives", () => {
  it("parses safe link directives", () => {
    const source = [
      "flowchart LR",
      "  A[Parser] --> B[Review]",
      "  %% link A file:packages/plannotator-ext/plan-parse.ts",
      "  %% link B stage:native-review",
      "  %% link C file:/etc/passwd",
      "  %% link D file:../outside.ts",
      "  %% link E file:~/secrets",
      "  %% link F file:C:/win.ts",
      "  %% link G stage:bad\"id",
      "  %% just a comment",
      "  %% link H http:example.com"
    ].join("\n")
    expect(parseLinkDirectives(source)).toEqual([
      { nodeId: "A", target: { kind: "file", path: "packages/plannotator-ext/plan-parse.ts" } },
      { nodeId: "B", target: { kind: "stage", id: "native-review" } }
    ])
  })
})

describe("MermaidDiagram links", () => {
  // Real hand-drawn flowchart output: node identity lives only in the DOM id.
  const svg = '<svg><g id="mermaid-r1-flowchart-A-0" class="rough-node"><text>Parser</text></g><g data-id="B"><text>Review</text></g><g id="mermaid-r1-flowchart-Z-2" class="rough-node"><text>Unlinked</text></g></svg>'
  const source = "flowchart LR\n  A --> B\n  %% link A file:src/a.ts\n  %% link B stage:review\n  %% link Z file:src/unknown.ts"

  it("opens linked files and scrolls to linked stages; unknown targets stay inert", async () => {
    render_.mockResolvedValue({ svg })
    const open = vi.fn()
    const stage = document.createElement("section")
    stage.setAttribute("data-stage", "review")
    const scrollIntoView = vi.fn()
    stage.scrollIntoView = scrollIntoView
    document.body.appendChild(stage)

    render(
      <OpenAssetProvider open={open} knownFiles={new Set(["src/a.ts"])}>
        <MermaidDiagram source={source} />
      </OpenAssetProvider>
    )

    fireEvent.click(await screen.findByRole("link", { name: "Open file src/a.ts" }))
    expect(open).toHaveBeenCalledWith("src/a.ts")

    fireEvent.keyDown(screen.getByRole("link", { name: "Open stage review" }), { key: "Enter" })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // src/unknown.ts is not a tracked file, so its node must not become a link.
    expect(screen.queryByRole("link", { name: "Open file src/unknown.ts" })).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
    stage.remove()
  })

  it("does not navigate when a node click ends a pan drag", async () => {
    render_.mockResolvedValue({ svg })
    const open = vi.fn()
    render(
      <OpenAssetProvider open={open} knownFiles={new Set(["src/a.ts"])}>
        <MermaidDiagram source={source} />
      </OpenAssetProvider>
    )
    const node = await screen.findByRole("link", { name: "Open file src/a.ts" })
    const canvas = screen.getByTestId("mermaid-canvas")
    fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 })
    fireEvent.pointerUp(canvas)
    expect(canvas.style.transform).toContain("translate(40px, 10px)")
    fireEvent.click(node)
    expect(open).not.toHaveBeenCalled()
  })

  it("zooms in, out, and resets within bounds", async () => {
    render_.mockResolvedValue({ svg })
    render(<MermaidDiagram source="graph TD; A-->B" />)
    const canvas = await screen.findByTestId("mermaid-canvas")
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(canvas.style.transform).toContain("scale(1.25)")
    for (let i = 0; i < 20; i += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
    expect(canvas.style.transform).toContain("scale(0.25)")
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }))
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(1)")
  })
})
