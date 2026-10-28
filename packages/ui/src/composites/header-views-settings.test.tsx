import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { HEADER_VIEWS_MAX } from "@jingler/core"
import { FileDiff, FolderTree, Globe, ListChecks, SquareTerminal, Waypoints } from "lucide-react"
import { HeaderViewButtons, type HeaderViewItem } from "../app/header-view-buttons.js"
import { HeaderViewsSettings } from "./header-views-settings.js"

afterEach(cleanup)

const views: HeaderViewItem[] = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "checks", label: "Checks", icon: ListChecks },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "plan", label: "Plan", icon: Waypoints }
]

/** Settings and the header share one pinned list, as in JinglerApp. */
function Host({ initial }: { initial: string[] }) {
  const [pinned, setPinned] = useState<ReadonlyArray<string>>(initial)
  const items = pinned.flatMap((id) => views.filter((v) => v.id === id))
  return (
    <>
      <HeaderViewButtons views={items} onOpen={() => {}} />
      <HeaderViewsSettings views={views} pinned={pinned} onChange={setPinned} />
    </>
  )
}

describe("HeaderViewsSettings", () => {
  it("pins from Settings into the header buttons and unpins back out", () => {
    render(<Host initial={["changes"]} />)
    expect(screen.queryByTestId("header-view-files")).toBeNull()
    fireEvent.click(screen.getByRole("switch", { name: "Pin Files to header" }))
    expect(screen.getByTestId("header-view-files")).toBeTruthy()
    fireEvent.click(screen.getByRole("switch", { name: "Pin Files to header" }))
    expect(screen.queryByTestId("header-view-files")).toBeNull()
  })

  it("refuses a sixth pin and shows the hint", () => {
    render(<Host initial={["changes", "checks", "terminal", "browser", "files"]} />)
    expect(HEADER_VIEWS_MAX).toBe(5)
    const plan = screen.getByRole("switch", { name: "Pin Plan to header" }) as HTMLButtonElement
    expect(plan.disabled).toBe(true)
    fireEvent.click(plan)
    expect(screen.queryByTestId("header-view-plan")).toBeNull()
    expect(screen.getByTestId("header-views-full")).toBeTruthy()
  })
})
