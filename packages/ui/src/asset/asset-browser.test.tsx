import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AssetFileEntry } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssetBrowser } from "./asset-browser.js"

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {}
    })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AssetBrowser", () => {
  it("keeps one Pierre tree model while paths, status, and active tabs change", async () => {
    const onSelectPath = vi.fn()
    const entries: AssetFileEntry[] = [
      { path: "src/main.ts", status: "modified" },
      { path: "docs/spec.md", status: "clean" }
    ]
    const view = render(
      <AssetBrowser
        sessionId="s1"
        entries={[]}
        selectedPath="src/main.ts"
        onSelectPath={onSelectPath}
        renderCanvas={(nativeAvailable) => <div>{String(nativeAvailable)}</div>}
      />
    )

    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        "[data-jingler-pierre-file-tree]"
      )
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })

    view.rerender(
      <AssetBrowser
        sessionId="s1"
        entries={entries}
        selectedPath="src/main.ts"
        onSelectPath={onSelectPath}
        renderCanvas={(nativeAvailable) => <div>{String(nativeAvailable)}</div>}
      />
    )
    await waitFor(() => {
      expect(
        host.shadowRoot!.querySelector<HTMLElement>('[data-item-path="src/main.ts"]')
          ?.tabIndex
      ).toBe(0)
    })
    const source = host.shadowRoot!.querySelector<HTMLElement>(
      '[data-item-path="src/main.ts"]'
    )!
    expect(source.dataset.itemGitStatus).toBe("modified")
    expect(source.getAttribute("aria-selected")).toBe("true")

    view.rerender(
      <AssetBrowser
        sessionId="s1"
        entries={[
          ...entries,
          { path: "out/results.csv", status: "untracked" }
        ]}
        selectedPath="docs/spec.md"
        onSelectPath={onSelectPath}
        renderCanvas={(nativeAvailable) => <div>{String(nativeAvailable)}</div>}
      />
    )

    await waitFor(() => {
      expect(document.querySelector("[data-jingler-pierre-file-tree]")).toBe(host)
      expect(
        host.shadowRoot!.querySelector('[data-item-path="docs/spec.md"]')
          ?.getAttribute("aria-selected")
      ).toBe("true")
      expect(
        host.shadowRoot!.querySelector<HTMLElement>('[data-item-path="out/results.csv"]')
          ?.dataset.itemGitStatus
      ).toBe("untracked")
    })

    fireEvent.click(
      host.shadowRoot!.querySelector<HTMLElement>('[data-item-path="out/results.csv"]')!
    )
    expect(onSelectPath).toHaveBeenCalledWith("out/results.csv")
  })

  it("suspends native canvas content until layout is measured and while the tree resizes", async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    render(
      <AssetBrowser
        sessionId="s1"
        entries={[{ path: "report.pdf", status: "clean" }]}
        selectedPath="report.pdf"
        onSelectPath={() => {}}
        renderCanvas={(nativeAvailable) => (
          <output data-testid="native-available">{String(nativeAvailable)}</output>
        )}
      />
    )

    expect(screen.getByTestId("native-available").textContent).toBe("false")
    for (const observer of observers) {
      observer([{ borderBoxSize: [{ inlineSize: 900 }], contentRect: { width: 900 } }])
    }
    await waitFor(() => {
      expect(screen.getByTestId("native-available").textContent).toBe("true")
    })
    const divider = screen.getByRole("separator", { name: "Resize repository browser" })
    fireEvent.pointerDown(divider, { clientX: 240 })
    expect(screen.getByTestId("native-available").textContent).toBe("false")
    fireEvent.pointerMove(window, { clientX: 280 })
    fireEvent.pointerUp(window)
    expect(screen.getByTestId("native-available").textContent).toBe("true")
  })

  it("uses a focusable sheet when the canvas cannot keep a readable width", async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    const onSelectPath = vi.fn()
    render(
      <AssetBrowser
        sessionId="s-constrained"
        entries={[{ path: "docs/spec.md", status: "modified" }]}
        selectedPath={null}
        onSelectPath={onSelectPath}
        renderCanvas={(nativeAvailable) => (
          <output data-testid="sheet-native-available">{String(nativeAvailable)}</output>
        )}
      />
    )

    for (const observer of observers) {
      observer([{ borderBoxSize: [{ inlineSize: 520 }], contentRect: { width: 520 } }])
    }
    const open = await screen.findByRole("button", { name: "Repository files" })
    await waitFor(() => expect(open.getAttribute("aria-expanded")).toBe("false"))
    expect(screen.getByTestId("sheet-native-available").textContent).toBe("true")

    fireEvent.click(open)
    expect(open.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("sheet-native-available").textContent).toBe("false")
    const host = document.querySelector<HTMLElement>("[data-jingler-pierre-file-tree]")!
    fireEvent.click(
      host.shadowRoot!.querySelector<HTMLElement>('[data-item-path="docs/spec.md"]')!
    )
    await waitFor(() => expect(open.getAttribute("aria-expanded")).toBe("false"))
    expect(screen.getByTestId("sheet-native-available").textContent).toBe("true")
  })
})
