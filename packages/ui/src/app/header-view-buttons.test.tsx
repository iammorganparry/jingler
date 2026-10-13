import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { FileDiff, Globe, ListChecks, SquareTerminal } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HeaderLinkChips, HeaderViewButtons, type HeaderViewItem } from "./header-view-buttons.js"

afterEach(cleanup)

const views: ReadonlyArray<HeaderViewItem> = [
  { id: "changes", label: "Changes", icon: FileDiff, count: "12", shortcut: "mod+shift+d" },
  { id: "checks", label: "Checks", icon: ListChecks, count: "3/4" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe }
]

describe("HeaderViewButtons", () => {
  it("draws one button per view with the count badge beside the label", () => {
    render(<HeaderViewButtons views={views} onOpen={vi.fn()} />)
    expect(screen.getAllByRole("button")).toHaveLength(4)
    expect(screen.getByTestId("header-view-changes").textContent).toBe("Changes12")
    expect(screen.getByTestId("header-view-checks").textContent).toBe("Checks3/4")
    expect(screen.getByTestId("header-view-terminal").textContent).toBe("Terminal")
  })

  it("opens the clicked view", () => {
    const onOpen = vi.fn()
    render(<HeaderViewButtons views={views} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId("header-view-browser"))
    expect(onOpen).toHaveBeenCalledWith("browser")
  })

  it("marks only the open view pressed, with no blue accent", () => {
    render(<HeaderViewButtons views={views} activeId="checks" onOpen={vi.fn()} />)
    const checks = screen.getByTestId("header-view-checks")
    expect(checks.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("header-view-changes").getAttribute("aria-pressed")).toBe("false")
    expect(checks.className).not.toMatch(/blue/)
  })
})

describe("HeaderLinkChips", () => {
  it("draws one chip per link and opens the clicked one", () => {
    const onPr = vi.fn()
    const onIssue = vi.fn()
    render(
      <HeaderLinkChips
        chips={[
          { id: "pr", label: "PR #482", title: "Open pull request", onOpen: onPr },
          { id: "issue", label: "LIN-482", title: "Open LIN-482", onOpen: onIssue }
        ]}
      />
    )
    fireEvent.click(screen.getByTestId("header-link-issue"))
    expect(onIssue).toHaveBeenCalledOnce()
    expect(onPr).not.toHaveBeenCalled()
    expect(screen.getByTestId("header-link-pr").textContent).toBe("PR #482")
  })
})
