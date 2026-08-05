import { cleanup, render, screen } from "@testing-library/react"
import { jinglerDark, toTokens } from "@jingler/themes"
import type { AssetPayload } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPierreFileDiff } from "../diff/pierre-model.js"
import { PierreProvider } from "../diff/pierre-provider.js"
import { AssetCanvas } from "./asset-canvas.js"

const base = { path: "src/main.ts", absolutePath: "/tmp/src/main.ts", size: 20 }
const code: AssetPayload = {
  ...base,
  kind: "code",
  language: "typescript",
  text: "export const value = 2\n"
}

const mount = (canvas: React.ReactNode) =>
  render(
    <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
      <div className="h-[400px]">{canvas}</div>
    </PierreProvider>
  )

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AssetCanvas", () => {
  it("uses Pierre File for clean source and Pierre FileDiff for changed source", () => {
    const clean = mount(<AssetCanvas selectedPath={code.path} payload={code} />)
    expect(clean.container.querySelector('[data-jingler-pierre-view="file"]')).toBeTruthy()
    clean.unmount()

    const fileDiff = createPierreFileDiff({
      path: code.path,
      status: "modified",
      before: "export const value = 1\n",
      after: code.text,
      language: "typescript"
    })
    const changed = mount(
      <AssetCanvas selectedPath={code.path} payload={code} fileDiff={fileDiff} />
    )
    expect(changed.container.querySelector('[data-jingler-pierre-view="diff"]')).toBeTruthy()
  })

  it("keeps markdown, PDF hosting, loading, and errors in the same canvas contract", () => {
    const markdown: AssetPayload = {
      ...base,
      path: "docs/spec.md",
      kind: "markdown",
      language: null,
      text: "# Browser spec"
    }
    const view = mount(
      <AssetCanvas selectedPath={markdown.path} payload={markdown} />
    )
    expect(screen.getByRole("heading", { name: "Browser spec" })).toBeTruthy()
    view.unmount()

    const pdf: AssetPayload = {
      ...base,
      path: "report.pdf",
      kind: "pdf"
    }
    mount(
      <AssetCanvas
        selectedPath={pdf.path}
        payload={pdf}
        renderPdf={(placeholder) => <div data-testid="native-pdf-host">{placeholder}</div>}
      />
    )
    expect(
      screen.getByTestId("native-pdf-host").contains(
        screen.getByTestId("asset-pdf-placeholder")
      )
    ).toBe(true)
    cleanup()

    mount(<AssetCanvas selectedPath="missing.txt" loading />)
    expect(screen.getByText("Loading…")).toBeTruthy()
    cleanup()
    mount(
      <AssetCanvas
        selectedPath="missing.txt"
        error={{ type: "error", message: "Couldn't open missing.txt." }}
      />
    )
    expect(screen.getByText("Couldn't open missing.txt.")).toBeTruthy()
  })
})
