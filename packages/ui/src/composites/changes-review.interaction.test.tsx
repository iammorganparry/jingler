import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import type { PrFileChange } from "@jingler/core"
import { ChangedFilesExplorer, ReviewFileDiff } from "./changes-review.js"

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

const COMPOSER_PLACEHOLDER = "Suggest a change or ask the agent to fix this…"

/**
 * Pierre re-renders its shadow DOM after first paint, so a line element found
 * early can be detached by the time it is clicked. Re-query and click until the
 * composer opens.
 */
const selectOldLineOne = () =>
  waitFor(
    () => {
      const line = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>('[data-column-number="1"]')
      expect(line?.isConnected).toBe(true)
      fireEvent.pointerDown(line!, { pointerId: 1, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 10 })
      return screen.getByPlaceholderText(COMPOSER_PLACEHOLDER)
    },
    { timeout: 5_000 }
  )

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

const file = (at: string): PrFileChange => ({
  path: at,
  additions: 1,
  deletions: 1,
  commentCount: 0,
  viewed: false
})

const diffProps = {
  drafts: [],
  connected: true,
  routeTargetSession: "Session",
  focused: false,
  onToggleFocus: () => {},
  onAddDraft: () => {},
  onRemoveDraft: () => {},
  onToggleViewed: () => {}
} as const

describe("ReviewFileDiff selection", () => {
  it("uses Pierre's old-side inclusive selection to place and submit the composer", async () => {
    const onAddDraft = vi.fn()
    render(
      <WidthTierValue width={1_240}>
        <ReviewFileDiff
          {...diffProps}
          file={file(path)}
          diff={patch}
          source="local"
          onAddDraft={onAddDraft}
        />
      </WidthTierValue>
    )

    const textarea = await selectOldLineOne()
    expect(screen.getByText(`${path.split("/").at(-1)} old L1`)).toBeTruthy()
    fireEvent.change(textarea, { target: { value: "Keep the legacy contract." } })
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }))

    expect(onAddDraft).toHaveBeenCalledExactlyOnceWith({
      path,
      line: 1,
      endLine: 2,
      body: "Keep the legacy contract.",
      routeToAgent: true
    })
    expect(screen.queryByPlaceholderText(COMPOSER_PLACEHOLDER)).toBeNull()
  })

  it("sends a comment straight to the agent without collecting a draft", async () => {
    const onAddDraft = vi.fn()
    const onSendComment = vi.fn()
    render(
      <WidthTierValue width={1_240}>
        <ReviewFileDiff
          {...diffProps}
          file={file(path)}
          diff={patch}
          source="local"
          onAddDraft={onAddDraft}
          onSendComment={onSendComment}
        />
      </WidthTierValue>
    )

    const textarea = await selectOldLineOne()
    const send = screen.getByRole("button", { name: "Send to agent" })
    expect(send.hasAttribute("disabled")).toBe(true)
    fireEvent.change(textarea, { target: { value: "Rename this." } })
    fireEvent.click(send)

    expect(onSendComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path, body: "Rename this." })
    )
    expect(onAddDraft).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText(COMPOSER_PLACEHOLDER)).toBeNull()
  })

  it("renders a hierarchical status-aware changed-files tree with model-owned keyboard focus", async () => {
    const otherPath = "src/store.ts"
    const onSelectFile = vi.fn()
    render(
      <WidthTierValue width={1_240}>
        <ChangedFilesExplorer
          files={[file(path), file(otherPath)]}
          fileDiffs={[
            { path, diff: patch },
            { path: otherPath, diff: patch.replaceAll(path, otherPath) }
          ]}
          drafts={[]}
          activePath={path}
          onSelectFile={onSelectFile}
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
      treeHost.shadowRoot!.querySelector("[data-item-type=folder]")
    ).toBeTruthy()
    expect(first.getAttribute("aria-level")).toBe("2")
    expect(first.dataset.itemGitStatus).toBe("modified")
    expect(first.getAttribute("aria-selected")).toBe("true")

    expect(first.getAttribute("role")).toBe("treeitem")
    expect(first.tabIndex).toBe(0)
    expect(second.getAttribute("role")).toBe("treeitem")
    fireEvent.click(second)
    expect(onSelectFile).toHaveBeenCalledWith(otherPath)
  })

  it("mounts saved drafts and GitHub threads as persistent Pierre annotations", async () => {
    render(
      <WidthTierValue width={1_240}>
        <ReviewFileDiff
          {...diffProps}
          file={file(path)}
          diff={patch}
          source="pr"
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
        />
      </WidthTierValue>
    )

    expect(
      (await screen.findAllByText("This draft stays attached too.")).length
    ).toBeGreaterThanOrEqual(1)
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
