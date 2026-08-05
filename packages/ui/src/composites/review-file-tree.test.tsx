import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { toTokens, jinglerDark } from "@jingler/themes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PierreProvider } from "../diff/pierre-provider.js"
import { ReviewFileTree } from "./review-file-tree.js"

const files = [
  { path: "README.md", additions: 1, deletions: 0, commentCount: 0, viewed: false },
  { path: "src/auth/login.ts", additions: 3, deletions: 1, commentCount: 0, viewed: false },
  { path: "src/auth/token.test.ts", additions: 2, deletions: 2, commentCount: 0, viewed: false }
]

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

const view = (
  activePath: string,
  onSelectFile: (path: string) => void,
  visibleFiles = files
) => (
  <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
    <div style={{ height: 360 }}>
      <ReviewFileTree
        files={visibleFiles}
        activePath={activePath}
        statusByPath={new Map([
          ["README.md", "modified"],
          ["src/auth/login.ts", "added"],
          ["src/auth/token.test.ts", "deleted"]
        ])}
        query=""
        onSelectFile={onSelectFile}
      />
    </div>
  </PierreProvider>
)

describe("ReviewFileTree", () => {
  it("exposes hierarchical names, Git status, focus, keyboard selection, and stable host identity", async () => {
    const onSelectFile = vi.fn()
    const rendered = render(view("src/auth/login.ts", onSelectFile))
    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-jingler-pierre-file-tree][aria-label="Changed files tree"]'
      )
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })
    const login = host.shadowRoot!.querySelector<HTMLElement>(
      '[data-item-path="src/auth/login.ts"]'
    )!
    const token = host.shadowRoot!.querySelector<HTMLElement>(
      '[data-item-path="src/auth/token.test.ts"]'
    )!

    expect(host.getAttribute("role")).toBe("region")
    expect(host.shadowRoot!.querySelector('[role="tree"]')).toBeTruthy()
    expect(host.shadowRoot!.querySelector('[data-item-type="folder"]')).toBeTruthy()
    expect(login.getAttribute("role")).toBe("treeitem")
    expect(login.getAttribute("aria-level")).toBe("3")
    expect(login.getAttribute("aria-selected")).toBe("true")
    expect(login.dataset.itemGitStatus).toBe("added")
    expect(token.dataset.itemGitStatus).toBe("deleted")
    expect(login.tabIndex).toBe(0)

    fireEvent.keyDown(login, { key: "ArrowDown" })
    await waitFor(() => expect(token.tabIndex).toBe(0))
    fireEvent.keyDown(token, { key: " ", code: "Space", ctrlKey: true })
    expect(onSelectFile).toHaveBeenCalledWith("src/auth/token.test.ts")

    rendered.rerender(
      view("src/auth/token.test.ts", onSelectFile, files.slice(1))
    )
    await waitFor(() => {
      expect(document.querySelector("[data-jingler-pierre-file-tree]")).toBe(host)
      expect(
        host.shadowRoot!.querySelector('[data-item-path="README.md"]')
      ).toBeNull()
      expect(
        host.shadowRoot!.querySelector('[data-item-path="src/auth/token.test.ts"]')
          ?.getAttribute("aria-selected")
      ).toBe("true")
    })
  })
})
