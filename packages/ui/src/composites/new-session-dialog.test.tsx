import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { NewSessionDialogProps } from "./new-session-dialog.js"
import { NewSessionDialog } from "./new-session-dialog.js"

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
afterAll(() => vi.unstubAllGlobals())

const props: NewSessionDialogProps = {
  open: true,
  onClose: () => {},
  repos: [
    {
      name: "widget",
      path: "/repos/widget",
      defaultBranch: "main",
      currentBranch: "main",
      remoteUrl: null,
      githubSlug: null
    }
  ],
  clis: [
    {
      kind: "claude",
      label: "Claude Code",
      binPath: "/usr/bin/claude",
      version: "1.0.0",
      available: true
    }
  ],
  loadBranches: async () => ["main"],
  onCreate: async () => {}
}

describe("NewSessionDialog workspace choice", () => {
  it("labels the default-on toggle and explains both workspace modes", () => {
    render(<NewSessionDialog {...props} />)

    const toggle = screen.getByRole("switch", {
      name: "Use isolated worktree"
    })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(
      screen.getByText("Creates an isolated fork of this branch for the session.")
    ).toBeDefined()

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(
      screen.getByText(
        "The agent shares this repository checkout and works directly on the selected branch."
      )
    ).toBeDefined()
  })

  it("turns worktree creation back on when the dialog reopens", () => {
    const view = render(<NewSessionDialog {...props} />)
    const toggle = screen.getByRole("switch", {
      name: "Use isolated worktree"
    })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")

    view.rerender(<NewSessionDialog {...props} open={false} />)
    view.rerender(<NewSessionDialog {...props} open />)
    expect(
      screen
        .getByRole("switch", { name: "Use isolated worktree" })
        .getAttribute("aria-checked")
    ).toBe("true")
  })
})
