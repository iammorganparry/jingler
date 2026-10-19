import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { FileDiff, FolderTree, Globe, ListChecks, NotebookPen, SquareTerminal, Waypoints } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HeaderViewItem } from "./header-view-buttons.js"
import { ViewOverflowMenu } from "./view-overflow-menu.js"

afterEach(cleanup)

const views: ReadonlyArray<HeaderViewItem> = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "checks", label: "Checks", icon: ListChecks },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "plan", label: "Plan", icon: Waypoints },
  { id: "linear.issues", label: "Linear issues", icon: NotebookPen, plugin: true }
]

const openMenu = () => fireEvent.pointerDown(screen.getByTestId("view-overflow-trigger"), { button: 0, ctrlKey: false })

describe("ViewOverflowMenu", () => {
  it("lists every view and splits plugin views under Plugins", () => {
    render(<ViewOverflowMenu views={views} pinned={["changes"]} onOpen={vi.fn()} onPinnedChange={vi.fn()} />)
    openMenu()
    expect(screen.getAllByText("Pin to header")).toHaveLength(views.length)
    expect(screen.getByText("Views")).toBeTruthy()
    expect(screen.getByText("Plugins")).toBeTruthy()
    expect(screen.getByTestId("open-linear.issues")).toBeTruthy()
  })

  it("opens a view from its row", () => {
    const onOpen = vi.fn()
    render(<ViewOverflowMenu views={views} pinned={[]} onOpen={onOpen} onPinnedChange={vi.fn()} />)
    openMenu()
    fireEvent.click(screen.getByTestId("open-files"))
    expect(onOpen).toHaveBeenCalledWith("files")
  })

  it("pins and unpins, keeping header order", () => {
    const onPinnedChange = vi.fn()
    render(<ViewOverflowMenu views={views} pinned={["changes", "checks"]} onOpen={vi.fn()} onPinnedChange={onPinnedChange} />)
    openMenu()
    fireEvent.click(screen.getByTestId("pin-files"))
    expect(onPinnedChange).toHaveBeenLastCalledWith(["changes", "checks", "files"])
    fireEvent.click(screen.getByTestId("pin-changes"))
    expect(onPinnedChange).toHaveBeenLastCalledWith(["checks"])
  })

  it("reorders pinned views with the up/down buttons and hides them on unpinned rows", () => {
    const onPinnedChange = vi.fn()
    render(<ViewOverflowMenu views={views} pinned={["changes", "checks", "terminal"]} onOpen={vi.fn()} onPinnedChange={onPinnedChange} />)
    openMenu()
    expect(screen.queryByTestId("move-files-up")).toBeNull()
    fireEvent.click(screen.getByTestId("move-checks-up"))
    expect(onPinnedChange).toHaveBeenLastCalledWith(["checks", "changes", "terminal"])
    expect((screen.getByTestId("move-changes-up") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("move-terminal-down") as HTMLButtonElement).disabled).toBe(true)
  })

  it("refuses a sixth pin and explains why in a tooltip", async () => {
    const onPinnedChange = vi.fn()
    const five = ["changes", "checks", "terminal", "browser", "files"]
    render(<ViewOverflowMenu views={views} pinned={five} onOpen={vi.fn()} onPinnedChange={onPinnedChange} />)
    openMenu()
    const sixth = screen.getByTestId("pin-plan")
    expect(sixth.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(sixth)
    expect(onPinnedChange).not.toHaveBeenCalled()
    fireEvent.focus(sixth)
    expect((await screen.findByRole("tooltip", { hidden: true })).textContent).toMatch(/Header is full \(5 pinned\)/)
    // Unpinning is still allowed when full.
    fireEvent.click(screen.getByTestId("pin-files"))
    expect(onPinnedChange).toHaveBeenCalledWith(["changes", "checks", "terminal", "browser"])
  })
})
