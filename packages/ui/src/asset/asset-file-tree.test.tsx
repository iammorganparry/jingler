import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { jinglerDark, toTokens } from "@jingler/themes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prepareJinglerFileTreeInput } from "../components/pierre-file-tree.js"
import { PierreProvider } from "../diff/pierre-provider.js"
import { AssetFileTree } from "./asset-file-tree.js"

beforeEach(() => {
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AssetFileTree", () => {
  it("prepares large canonical repositories without duplicate paths", () => {
    const paths = Array.from(
      { length: 10_000 },
      (_, index) => `./packages\\generated\\file-${String(index).padStart(5, "0")}.ts`
    )
    const prepared = prepareJinglerFileTreeInput([
      ...paths,
      "packages/generated/file-00000.ts"
    ], { presorted: false })

    expect(prepared.paths).toHaveLength(10_000)
    expect(prepared.paths[0]).toMatch(/^packages\/generated\//)
    expect(new Set(prepared.paths).size).toBe(prepared.paths.length)
  })

  it("keeps a bounded mounted window and keyboard-searches a large repository", async () => {
    const entries = [
      ...Array.from({ length: 2_000 }, (_, index) => ({
        path: `file-${String(index).padStart(4, "0")}.ts`,
        status: index % 2 === 0 ? "clean" as const : "modified" as const
      })),
      { path: "target.md", status: "untracked" as const }
    ]
    const onSelectPath = vi.fn()
    render(
      <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
        <div style={{ height: 320 }}>
          <AssetFileTree
            entries={entries}
            selectedPath="file-0000.ts"
            onSelectPath={onSelectPath}
            className="h-full"
          />
        </div>
      </PierreProvider>
    )

    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
      )
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })
    await waitFor(() => {
      const mounted = host.shadowRoot!.querySelectorAll('[role="treeitem"]')
      expect(mounted.length).toBeGreaterThan(0)
      expect(mounted.length).toBeLessThan(200)
    })

    const focused = host.shadowRoot!.querySelector<HTMLElement>('[tabindex="0"]')!
    fireEvent.keyDown(focused, { key: "t" })
    const search = await waitFor(() => {
      const element = host.shadowRoot!.querySelector<HTMLInputElement>(
        "[data-file-tree-search-input]"
      )
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.input(search, { target: { value: "target.md" } })
    await waitFor(() => expect(search.value).toBe("target.md"))
    fireEvent.keyDown(search, { key: "Enter" })
    await waitFor(() =>
      expect(onSelectPath).toHaveBeenCalledWith("target.md")
    )
  })

  it("hydrates an initially empty tree with a large asynchronous repository", async () => {
    const onSelectPath = vi.fn()
    const view = render(
      <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
        <div style={{ height: 320 }}>
          <AssetFileTree
            entries={[]}
            selectedPath={null}
            onSelectPath={onSelectPath}
            className="h-full"
          />
        </div>
      </PierreProvider>
    )
    const entries = [
      ...Array.from({ length: 5_590 }, (_, index) => ({
        path: `packages/generated/file-${String(index).padStart(5, "0")}.ts`,
        status: "clean" as const
      })),
      { path: "apps/web/src/features/signals/account-dossier.tsx", status: "modified" as const }
    ]

    view.rerender(
      <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
        <div style={{ height: 320 }}>
          <AssetFileTree
            entries={entries}
            selectedPath={null}
            onSelectPath={onSelectPath}
            className="h-full"
          />
        </div>
      </PierreProvider>
    )

    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
      )
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })
    const focused = await waitFor(() => {
      const element = host.shadowRoot!.querySelector<HTMLElement>('[tabindex="0"]')
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.keyDown(focused, { key: "a" })
    const search = await waitFor(() => {
      const element = host.shadowRoot!.querySelector<HTMLInputElement>(
        "[data-file-tree-search-input]"
      )
      expect(element).toBeTruthy()
      return element!
    })
    fireEvent.input(search, { target: { value: "account-dossier.tsx" } })
    fireEvent.keyDown(search, { key: "Enter" })

    await waitFor(() =>
      expect(onSelectPath).toHaveBeenCalledWith(
        "apps/web/src/features/signals/account-dossier.tsx"
      )
    )
  })
})
