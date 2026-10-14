import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { VirtualList } from "./virtual-list.js"

interface Entry {
  readonly id: string
  readonly group: string
}

const VIEWPORT = 256
const ENTRIES: ReadonlyArray<Entry> = Array.from({ length: 1000 }, (_, i) => ({
  id: `row-${String(i).padStart(4, "0")}`,
  group: `Group ${Math.floor(i / 100)}`
}))

const getKey = (entry: Entry) => entry.id
const getText = (entry: Entry) => entry.id
const getGroup = (entry: Entry) => entry.group
const renderRow = (entry: Entry) => <span>{entry.id}</span>

function List({ query = "", grouped = false, onSelect = () => {} }: {
  query?: string
  grouped?: boolean
  onSelect?: (entry: Entry) => void
}) {
  return (
    <VirtualList
      items={ENTRIES}
      getKey={getKey}
      getText={getText}
      getGroup={grouped ? getGroup : undefined}
      renderRow={renderRow}
      onSelect={onSelect}
      query={query}
      ariaLabel="Rows"
    />
  )
}

const activeText = () => screen.getByRole("option", { selected: true }).textContent
const pressKey = (key: string, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(screen.getByRole("listbox"), { key })
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(VIEWPORT)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300)
  // jsdom has no layout: emulate the browser scrolling the element and firing `scroll`.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, { top = 0 }: ScrollToOptions) {
      Object.defineProperty(this, "scrollTop", { configurable: true, writable: true, value: top })
      this.dispatchEvent(new Event("scroll"))
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
})

describe("VirtualList", () => {
  it("renders only a window of 1,000 items", () => {
    render(<List />)
    const mounted = screen.getAllByRole("option").length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(30)
    expect(screen.queryByText("row-0500")).toBeNull()
  })

  it("moves the active row with the arrow keys and scrolls it into view", () => {
    render(<List />)
    expect(activeText()).toBe("row-0000")
    pressKey("ArrowDown", 40)
    expect(activeText()).toBe("row-0040")
    expect(screen.getByRole("listbox").scrollTop).toBeGreaterThan(0)
    expect(screen.queryByText("row-0000")).toBeNull()

    pressKey("End")
    expect(activeText()).toBe("row-0999")
    pressKey("Home")
    expect(activeText()).toBe("row-0000")
    expect(screen.getByRole("listbox").scrollTop).toBe(0)
    pressKey("ArrowUp")
    expect(activeText()).toBe("row-0000")
  })

  it("selects the active row on Enter and on click", () => {
    const onSelect = vi.fn()
    render(<List onSelect={onSelect} />)
    pressKey("ArrowDown", 2)
    pressKey("Enter")
    expect(onSelect).toHaveBeenLastCalledWith(ENTRIES[2])
    fireEvent.click(screen.getByText("row-0004"))
    expect(onSelect).toHaveBeenLastCalledWith(ENTRIES[4])
  })

  it("keeps the selection while filtering and restores it when the filter clears", () => {
    const { rerender } = render(<List />)
    pressKey("ArrowDown", 5)
    expect(activeText()).toBe("row-0005")

    rerender(<List query="row-000" />)
    expect(screen.getAllByRole("option")).toHaveLength(10)
    expect(activeText()).toBe("row-0005")

    rerender(<List query="row-01" />)
    expect(activeText()).toBe("row-0100")

    rerender(<List query="" />)
    expect(activeText()).toBe("row-0005")
  })

  it("shows an empty state when nothing matches", () => {
    render(<List query="zzz" />)
    expect(screen.getByRole("status").textContent).toBe("No matches")
  })

  it("pins the header of the group in view", () => {
    render(<List grouped />)
    expect(screen.getByTestId("virtual-list-sticky-header").textContent).toBe("Group 0")
    pressKey("ArrowDown", 250)
    expect(activeText()).toBe("row-0250")
    expect(screen.getByTestId("virtual-list-sticky-header").textContent).toBe("Group 2")
  })
})
