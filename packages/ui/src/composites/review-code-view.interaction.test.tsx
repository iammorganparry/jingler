import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CodeView as PierreCodeViewModel } from "@pierre/diffs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { CodeReviewView } from "./code-review-view.js"

const path = "src/session.ts"
const patch = [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1,2 +1,2 @@",
  "-const token = oldToken",
  "+const token = nextToken",
  " export { token }"
].join("\n")

let nativeScrollTo: typeof HTMLElement.prototype.scrollTo

beforeEach(() => {
  nativeScrollTo = HTMLElement.prototype.scrollTo
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (nativeScrollTo === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
  } else {
    HTMLElement.prototype.scrollTo = nativeScrollTo
  }
})

describe("ReviewCodeView selection", () => {
  it("uses Pierre's old-side inclusive selection to place and submit the composer", async () => {
    const onAddDraft = vi.fn()
    render(
      <WidthTierValue width={1_240}>
        <CodeReviewView
          files={[
            {
              path,
              additions: 1,
              deletions: 1,
              commentCount: 0,
              viewed: false
            }
          ]}
          activePath={path}
          fileDiffs={[{ path, diff: patch }]}
          drafts={[]}
          routeTargetSession="Session"
          connected
          source="local"
          prAvailable={false}
          localAvailable
          onSetSource={() => {}}
          onSelectFile={() => {}}
          onToggleViewed={() => {}}
          onAddDraft={onAddDraft}
          onRemoveDraft={() => {}}
          onFinishReview={() => {}}
        />
      </WidthTierValue>
    )

    const container = await waitFor(() => {
      const element = document.querySelector("diffs-container")
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })
    const oldLine = await waitFor(() => {
      const element = container.shadowRoot?.querySelector<HTMLElement>(
        '[data-column-number="1"]'
      )
      expect(element).toBeTruthy()
      return element!
    })

    fireEvent.pointerDown(oldLine, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 10 })

    const textarea = await screen.findByPlaceholderText(
      "Suggest a change or ask the agent to fix this…"
    )
    expect(screen.getByText(`${path.split("/").at(-1)} old L1`)).toBeTruthy()
    fireEvent.change(textarea, { target: { value: "Keep the legacy contract." } })
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }))

    expect(onAddDraft).toHaveBeenCalledExactlyOnceWith({
      path,
      line: 1,
      endLine: null,
      body: "Keep the legacy contract.",
      routeToAgent: true
    })
    expect(
      screen.queryByPlaceholderText("Suggest a change or ask the agent to fix this…")
    ).toBeNull()
  })

  it("renders a hierarchical status-aware tree with model-owned keyboard focus", async () => {
    const otherPath = "src/store.ts"
    const onSelectFile = vi.fn()
    const scrollTo = vi.spyOn(PierreCodeViewModel.prototype, "scrollTo")
    render(
      <WidthTierValue width={1_240}>
        <CodeReviewView
          files={[
            {
              path,
              additions: 1,
              deletions: 1,
              commentCount: 0,
              viewed: false
            },
            {
              path: otherPath,
              additions: 1,
              deletions: 1,
              commentCount: 0,
              viewed: false
            }
          ]}
          activePath={path}
          fileDiffs={[
            { path, diff: patch },
            { path: otherPath, diff: patch.replaceAll(path, otherPath) }
          ]}
          drafts={[]}
          routeTargetSession="Session"
          connected
          source="local"
          prAvailable={false}
          localAvailable
          onSetSource={() => {}}
          onSelectFile={onSelectFile}
          onToggleViewed={() => {}}
          onAddDraft={() => {}}
          onRemoveDraft={() => {}}
          onFinishReview={() => {}}
        />
      </WidthTierValue>
    )

    const treeHost = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        "[data-jingler-pierre-file-tree]"
      )
      expect(element?.shadowRoot).toBeTruthy()
      return element!
    })
    const first = treeHost.shadowRoot!.querySelector<HTMLElement>(
      `[data-item-path="${path}"]`
    )!
    const second = treeHost.shadowRoot!.querySelector<HTMLElement>(
      `[data-item-path="${otherPath}"]`
    )!

    expect(
      treeHost.shadowRoot!.querySelector('[data-item-type="folder"]')
    ).toBeTruthy()
    expect(first.getAttribute("aria-level")).toBe("2")
    expect(first.dataset.itemGitStatus).toBe("modified")
    expect(first.getAttribute("aria-selected")).toBe("true")

    expect(first.getAttribute("role")).toBe("treeitem")
    expect(first.tabIndex).toBe(0)
    expect(second.getAttribute("role")).toBe("treeitem")
    fireEvent.click(second)
    expect(onSelectFile).toHaveBeenCalledWith(otherPath)
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({
        type: "item",
        id: otherPath,
        align: "start",
        behavior: "smooth"
      })
    )
  })

  it("mounts saved drafts and GitHub threads as persistent Pierre annotations", async () => {
    render(
      <WidthTierValue width={1_240}>
        <CodeReviewView
          files={[
            {
              path,
              additions: 1,
              deletions: 1,
              commentCount: 0,
              viewed: false
            }
          ]}
          reviewThreads={[
            {
              id: "thread-1",
              reviewId: null,
              path,
              line: 2,
              startLine: null,
              originalLine: null,
              originalStartLine: null,
              diffHunk: "",
              isResolved: false,
              isOutdated: false,
              resolvedBy: null,
              comments: [
                {
                  id: "comment-1",
                  databaseId: 1,
                  author: "reviewer",
                  authorAvatarUrl: null,
                  isBot: false,
                  association: "MEMBER",
                  body: "This thread stays attached to the changed line.",
                  createdAt: "2026-08-05T10:00:00.000Z",
                  reactions: []
                }
              ]
            }
          ]}
          activePath={path}
          fileDiffs={[{ path, diff: patch }]}
          drafts={[
            {
              id: "draft-1",
              path,
              line: 2,
              endLine: null,
              body: "This draft stays attached too.",
              routeToAgent: false
            }
          ]}
          routeTargetSession="Session"
          connected
          source="pr"
          prAvailable
          localAvailable={false}
          onSetSource={() => {}}
          onSelectFile={() => {}}
          onToggleViewed={() => {}}
          onAddDraft={() => {}}
          onRemoveDraft={() => {}}
          onFinishReview={() => {}}
        />
      </WidthTierValue>
    )

    expect(
      (await screen.findAllByText("This draft stays attached too.")).length
    ).toBeGreaterThanOrEqual(2)
    expect(
      await screen.findByText("This thread stays attached to the changed line.")
    ).toBeTruthy()
    expect(
      document.querySelector('[data-jingler-pierre-annotation="saved-draft"]')
    ).toBeTruthy()
    expect(
      document.querySelector('[data-jingler-pierre-annotation="review-thread"]')
    ).toBeTruthy()
    expect(document.querySelector("[data-review-thread-annotation]")).toBeTruthy()
  })
})
