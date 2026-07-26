import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { TabBar, type TabKey } from "./tab-bar.js"

afterEach(cleanup)

const TABS: ReadonlyArray<TabKey> = ["conversation", "plan", "pr", "review"]

const noop = () => {}

const renderAt = (width: number, extra: Partial<React.ComponentProps<typeof TabBar>> = {}) =>
  render(
    <WidthTierValue width={width}>
      <TabBar
        tabs={TABS}
        active="review"
        onChange={noop}
        onClosePane={noop}
        onToggleSplit={noop}
        onMovePaneLeft={noop}
        onMovePaneRight={noop}
        {...extra}
      />
    </WidthTierValue>
  )

describe("TabBar at width", () => {
  it("labels the SELECTED view tab and leaves the rest as glyphs", () => {
    renderAt(1200)
    // The row now carries the chat pills too, and a chat title is the thing you
    // actually read to tell two conversations apart — so the view tabs spend
    // their width only on the one you're looking at.
    expect(screen.getByText("Code Review")).toBeTruthy()
    expect(screen.queryByText("Pull Request")).toBeNull()
  })

  it("drops even the active label below the mid tier", () => {
    renderAt(420)
    expect(screen.queryByText("Code Review")).toBeNull()
  })

  it("keeps every tab reachable by name once the labels are hidden", () => {
    renderAt(600)
    // The aria-label survives the text being dropped, so a screen reader and a
    // by-name lookup both still find the tab.
    expect(screen.getByRole("button", { name: "Pull Request" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Conversation" })).toBeTruthy()
  })

  it("wears the session's name on the conversation tab, not the word 'Conversation'", () => {
    // The chip and the Conversation tab used to be two controls for one idea,
    // one of which you couldn't click. This is the merge.
    renderAt(1200, { sessionTitle: "feat(signals): account-first resolution" })
    expect(screen.getByText("feat(signals): account-first resolution")).toBeTruthy()
  })

  it("gives the session title less room as the pane narrows, and drops it at tiny", () => {
    const title = "feat(signals): account-first resolution"
    const widthAt = (width: number) => {
      cleanup()
      renderAt(width, { sessionTitle: title })
      return screen.queryByText(title)?.className ?? null
    }
    expect(widthAt(1200)).toContain("max-w-[210px]")
    expect(widthAt(600)).toContain("max-w-[150px]")
    expect(widthAt(420)).toContain("max-w-[92px]")
    // At `tiny` there is no room for a name — the tab keeps its tooltip and,
    // when the session is doing something, a status dot.
    expect(widthAt(320)).toBeNull()
  })

  it("renders the chat pills inside the row, behind a divider", () => {
    // The whole point of the redesign: what used to be a second ruled strip is
    // now a slot in this one.
    renderAt(1200, { chatSlot: <button type="button">Lets review the PR</button> })
    const row = screen.getByTestId("session-tab-bar")
    expect(within(row).getByText("Lets review the PR")).toBeTruthy()
  })

  it("collapses the diff counts to a dot below the mid tier", () => {
    const changes = { added: 681, removed: 0 }
    renderAt(1200, { tabs: ["conversation", "changes"], changes })
    expect(screen.getByText("+681")).toBeTruthy()
    cleanup()
    // "+681 −0" is up to seven tabular glyphs per tab — a whole chat pill's worth
    // of width, spent on something the Changes view itself says better.
    renderAt(420, { tabs: ["conversation", "changes"], changes })
    expect(screen.queryByText("+681")).toBeNull()
  })

  it("folds the pane actions into a menu below the mid tier", () => {
    renderAt(420)
    expect(screen.queryByTestId("move-pane-left")).toBeNull()
    // The split toggle, not the browser one: the preview dock is app-level and
    // its control now lives in the window title bar, which never collapses.
    expect(screen.queryByLabelText("Split plan beside conversation")).toBeNull()
    expect(screen.getByTestId("pane-actions-menu")).toBeTruthy()
  })

  it("never collapses close-pane — the one control you need BECAUSE the pane is narrow", () => {
    renderAt(320)
    expect(screen.getByTestId("close-pane")).toBeTruthy()
  })

  it("still fires the collapsed actions from the menu", () => {
    const onMovePaneLeft = vi.fn()
    renderAt(420, { onMovePaneLeft })
    fireEvent.pointerDown(
      screen.getByTestId("pane-actions-menu"),
      new PointerEvent("pointerdown", { bubbles: true, ctrlKey: false, button: 0 })
    )
    fireEvent.click(screen.getByLabelText("Move pane left"))
    expect(onMovePaneLeft).toHaveBeenCalledOnce()
  })

  it("renders no overflow menu when there is nothing to collapse into it", () => {
    render(
      <WidthTierValue width={420}>
        <TabBar tabs={TABS} active="conversation" onChange={noop} />
      </WidthTierValue>
    )
    expect(screen.queryByTestId("pane-actions-menu")).toBeNull()
  })
})
