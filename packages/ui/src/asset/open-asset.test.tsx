import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Markdown } from "../components/markdown.js"
import { ToolCall } from "../composites/tool-call.js"
import { OpenAssetProvider } from "./open-asset-context.js"

/**
 * The three routes from agent output into the Preview dock, end to end through
 * the real components.
 *
 * The unit tests in `path-detect.test.ts` cover WHICH strings qualify; these
 * cover the wiring — that a qualifying string actually becomes clickable, that a
 * non-qualifying one stays inert, and (the case that regressed once already)
 * that with no provider mounted every one of these renders exactly as it did
 * before the feature existed.
 */
// The suite renders into one shared document, so without this each test sees
// the previous test's DOM and every by-role query finds two of everything.
afterEach(cleanup)

const FILES = new Set(["docs/spec.md", "src/index.ts", "package.json"])

const withProvider = (node: ReactNode, open = vi.fn()) => {
  render(
    <OpenAssetProvider open={open} knownFiles={FILES}>
      {node}
    </OpenAssetProvider>
  )
  return open
}

describe("tool-call file paths", () => {
  it("opens the file when the path is one we can show", async () => {
    const open = withProvider(<ToolCall status="success" name="Write" filePath="/w/docs/spec.md" />)
    await userEvent.click(screen.getByTitle("Open spec.md"))
    expect(open).toHaveBeenCalledWith("docs/spec.md")
  })

  it("leaves the path inert when it is not in the worktree", () => {
    withProvider(<ToolCall status="success" name="Write" filePath="/w/docs/other.md" />)
    expect(screen.queryByTitle("Open other.md")).toBeNull()
    expect(screen.getByText("other.md")).toBeTruthy()
  })

  it("does not collapse an expandable card when the filename is clicked", async () => {
    // The card header is itself a toggle; without stopPropagation the click
    // would both open the file and fold the card shut under it.
    const onToggle = vi.fn()
    const open = vi.fn()
    render(
      <OpenAssetProvider open={open} knownFiles={FILES}>
        <ToolCall
          status="success"
          name="Write"
          filePath="/w/docs/spec.md"
          expanded
          onToggle={onToggle}
        />
      </OpenAssetProvider>
    )
    await userEvent.click(screen.getByTitle("Open spec.md"))
    expect(open).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("renders as plain text with no provider — Storybook must be unaffected", () => {
    render(<ToolCall status="success" name="Write" filePath="/w/docs/spec.md" />)
    expect(screen.queryByTitle("Open spec.md")).toBeNull()
    expect(screen.getByText("spec.md")).toBeTruthy()
  })
})

describe("inline code paths in prose", () => {
  it("opens a path that exists in the worktree", async () => {
    const open = withProvider(<Markdown>{"See `docs/spec.md` for details."}</Markdown>)
    await userEvent.click(screen.getByTitle("Open docs/spec.md"))
    expect(open).toHaveBeenCalledWith("docs/spec.md")
  })

  it("leaves a version string alone", () => {
    // The failure this guards: every third token in a transcript becoming a
    // dead link.
    withProvider(<Markdown>{"Upgraded to `v1.2.3` today."}</Markdown>)
    expect(screen.queryByTitle(/^Open /)).toBeNull()
  })

  it("leaves a dotted identifier alone", () => {
    withProvider(<Markdown>{"Run `npm.install` first."}</Markdown>)
    expect(screen.queryByTitle(/^Open /)).toBeNull()
  })

  it("does not turn a fenced block's body into a link", () => {
    withProvider(<Markdown>{"```\ndocs/spec.md\n```"}</Markdown>)
    expect(screen.queryByTitle(/^Open /)).toBeNull()
  })
})

describe("markdown links to relative paths", () => {
  it("opens the file instead of navigating", async () => {
    const open = withProvider(<Markdown>{"Read [the spec](./docs/spec.md)."}</Markdown>)
    await userEvent.click(screen.getByText("the spec"))
    expect(open).toHaveBeenCalledWith("docs/spec.md")
  })

  it("leaves an external link completely alone", async () => {
    const open = withProvider(<Markdown>{"See [the docs](https://example.com/a.md)."}</Markdown>)
    await userEvent.click(screen.getByText("the docs"))
    expect(open).not.toHaveBeenCalled()
  })
})
