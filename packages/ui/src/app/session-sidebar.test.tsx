import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_FILTERS } from "./session-filters.js"
import { SessionSidebar } from "./session-sidebar.js"
import type { SplitGroup } from "./split-layout.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const rowOrder = () =>
  Array.from(document.querySelectorAll("[data-testid^='session-row-']")).map((el) =>
    el.getAttribute("data-testid")!.replace("session-row-", "")
  )

describe("SessionSidebar archived sessions", () => {
  it("orders archived sessions by when they were ARCHIVED, not last updated", () => {
    // The regression: `sessions` arrives ordered by `updatedAt`. A session whose
    // last turn was days ago but which was archived just now must still surface at
    // the top of the group — otherwise the session you just lost is buried
    // mid-list exactly when you go looking for it.
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        // Archived is a FILTER now, not a group pinned to the bottom, so the
        // view has to be asked for. The ordering rule it pins is unchanged.
        defaultFilters={{ ...DEFAULT_FILTERS, status: "archived" }}
        sessions={[
          session({
            id: "recently-updated",
            updatedAt: "2026-07-18T07:00:00.000Z",
            archived: true,
            archiveReason: "merged",
            archivedAt: "2026-07-18T08:00:00.000Z"
          }),
          session({
            id: "stale-but-just-archived",
            updatedAt: "2026-07-16T15:42:00.000Z",
            archived: true,
            archiveReason: "merged",
            archivedAt: "2026-07-18T14:25:00.000Z"
          })
        ]}
      />
    )

    expect(rowOrder()).toStrictEqual(["stale-but-just-archived", "recently-updated"])
  })

  it("keeps a merged-PR session in its repo group instead of archiving it", () => {
    // A session holds ONE prNumber but can outlive several PRs, so a merged PR
    // badges the row and leaves the session active. Only `archived` retires it.
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        sessions={[session({ id: "multi-pr", prNumber: 204 })]}
        prStates={{ "multi-pr": { state: "merged", checks: null } }}
      />
    )

    expect(rowOrder()).toStrictEqual(["multi-pr"])
    // The state words moved to the leading glyph; the badge keeps the number.
    expect(screen.getByText(/#204/)).toBeDefined()
    expect(screen.getByTitle("Pull request merged")).toBeDefined()
  })
})

/**
 * A split is ONE sidebar row, and it must survive every way the list can shrink
 * beneath it. An early version keyed the row on `panes[0]`, so any list that
 * didn't happen to contain the first pane rendered no pill at all — the split
 * stayed on screen with nothing in the sidebar pointing at it. These pin the
 * conditions that used to break it; where the row SITS is the next block down.
 */
describe("SessionSidebar split pill presence", () => {
  const SPLIT: SplitGroup = {
    id: "g:first",
    panes: [
      { sessionId: "first", ratio: 0.5 },
      { sessionId: "second", ratio: 0.5 }
    ],
    focused: 0
  }

  const renderSidebar = (
    sessions: ReadonlyArray<ReturnType<typeof session>>,
    filters = DEFAULT_FILTERS
  ) =>
    render(
      <SessionSidebar
        activeSessionId="first"
        onSelect={() => {}}
        sessions={sessions}
        splitGroups={[SPLIT]}
        activeGroupId="g:first"
        defaultFilters={filters}
      />
    )

  const both = [
    session({ id: "first", title: "Refactor auth flow" }),
    session({ id: "second", title: "Bump the toolchain" })
  ]

  it("draws the pill once, at the first pane, when everything is showing", () => {
    renderSidebar(both)
    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    expect(screen.getByTestId("split-segment-first")).toBeDefined()
    expect(screen.getByTestId("split-segment-second")).toBeDefined()
    // And neither member is ALSO drawn as a plain row.
    expect(rowOrder()).toStrictEqual([])
  })

  it("still draws the pill when the narrowing keeps only a LATER pane", () => {
    // The regression: narrowing to pane 2 left pane 1 with no entry to hang the
    // pill on, while pane 2's entry bowed out for not being first. The sidebar
    // found a session and then rendered nothing whatsoever.
    //
    // Driven by the REPO facet rather than by typing. This used to type
    // "toolchain" into the sidebar's "Filter sessions…" field; that field is
    // gone — search is global now and lives in the title bar — but the property
    // being pinned is about the pill surviving a shrunken list, not about how
    // the list shrank. The repo filter is the narrowing this panel still owns.
    renderSidebar(
      [
        session({ id: "first", title: "Refactor auth flow", repo: "jingler" }),
        session({ id: "second", title: "Bump the toolchain", repo: "gtm-grid" })
      ],
      { ...DEFAULT_FILTERS, repo: "gtm-grid" }
    )

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    expect(screen.getByTestId("split-segment-second")).toBeDefined()
  })

  it("still draws the pill when the FIRST pane's session is missing from the list", () => {
    // Defence in depth, using archiving as the way to make a member absent.
    //
    // The app no longer reaches this state — archiving evicts a session from its
    // split (`use-split-layout`'s prune) precisely so it can't be in two sidebar
    // places at once. But this component takes `splitGroups` as data and cannot
    // police where it came from: a stale persisted workspace arriving one render
    // before the prune runs looks exactly like this. Ownership must not depend
    // on `panes[0]` being present, and that is what this pins.
    // Default filters — Status: Active — so the archived first pane is genuinely
    // ABSENT from the list, which is the condition being pinned.
    renderSidebar([
      session({ id: "first", title: "Refactor auth flow", archived: true, archivedAt: "2026-07-18T08:00:00.000Z" }),
      session({ id: "second", title: "Bump the toolchain" })
    ])

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
    expect(screen.getByTestId("split-segment-second")).toBeDefined()
    // No plain rows: `second` is drawn as a segment of the pill, and `first` is
    // filtered out entirely. Previously `first` ALSO appeared as its own row in
    // the Archived group, so one session occupied two places in the sidebar.
    expect(rowOrder()).toStrictEqual([])
  })

  it("draws no pill when the narrowing excludes every pane", () => {
    // Same conversion as the test above, with one wrinkle: the excluding repo
    // has to EXIST. `reconcileRepo` deliberately clears a repo filter that no
    // live session belongs to — a persisted filter naming a vanished repo would
    // otherwise empty the sidebar with no visible cause — so filtering on a
    // made-up name shows everything and pins nothing. Hence the third session:
    // it makes "elsewhere" a real place for the filter to point at.
    renderSidebar(
      [
        session({ id: "first", title: "Refactor auth flow", repo: "jingler" }),
        session({ id: "second", title: "Bump the toolchain", repo: "jingler" }),
        session({ id: "third", title: "Unrelated work", repo: "elsewhere" })
      ],
      { ...DEFAULT_FILTERS, repo: "elsewhere" }
    )

    expect(screen.queryByTestId("split-row-g:first")).toBeNull()
  })

  it("draws ONE pill for a split that spans two repo groups", () => {
    // A split is a top-level thing now, resolved against the whole active list
    // — drawing it per group would put the same pill in both repos.
    renderSidebar([
      session({ id: "first", title: "Refactor auth flow", repo: "jingler" }),
      session({ id: "second", title: "Bump the toolchain", repo: "gtm-grid" })
    ])

    expect(screen.getAllByTestId("split-row-g:first")).toHaveLength(1)
  })
})

/**
 * Where a split SITS.
 *
 * It used to hang inside whichever repo group its first surviving pane landed
 * in, which was defensible while a split meant two sessions from one repo. Once
 * you can split across repos it is a claim the data doesn't support: the pill
 * named one repo as its home while the other repo's session showed nothing of
 * its own. Splits belong above the repo groups, under the filters.
 */
describe("SessionSidebar split placement", () => {
  const SPLIT: SplitGroup = {
    id: "g:first",
    panes: [
      { sessionId: "first", ratio: 0.5 },
      { sessionId: "second", ratio: 0.5 }
    ],
    focused: 0
  }

  /** Heading labels and split pills, in the order they appear in the DOM. */
  const outline = () =>
    Array.from(document.querySelectorAll("[data-testid^='split-row-'], [data-testid='session-sidebar'] span"))
      .filter((el) => el.getAttribute("data-testid")?.startsWith("split-row-") || el.tagName === "SPAN")
      .map((el) => el.getAttribute("data-testid") ?? el.textContent)

  const crossRepo = [
    session({ id: "first", title: "Refactor auth flow", repo: "trigify-app" }),
    session({ id: "second", title: "Bump the toolchain", repo: "gtm-grid" }),
    session({ id: "loose", title: "Loose end", repo: "trigify-app" })
  ]

  const renderSidebar = (sessions: ReadonlyArray<ReturnType<typeof session>>) =>
    render(
      <SessionSidebar
        activeSessionId="first"
        onSelect={() => {}}
        sessions={sessions}
        splitGroups={[SPLIT]}
        activeGroupId="g:first"
        defaultFilters={DEFAULT_FILTERS}
      />
    )

  it("puts the split above every repo heading", () => {
    renderSidebar(crossRepo)
    const order = outline()
    // `gtm-grid` is deliberately not asserted on: its only session is in the
    // split, so its heading is gone — see the group-holdout test below.
    expect(order.indexOf("split-row-g:first")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("trigify-app")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("split-row-g:first")).toBeLessThan(order.indexOf("trigify-app"))
  })

  it("labels the section and counts the splits in it", () => {
    renderSidebar(crossRepo)
    // Singular for one — "Splits 1" reads like a category with a stray number.
    expect(screen.getByText("Split")).toBeDefined()
  })

  // The count badge under a repo heading has to match the rows beneath it.
  // Leaving split members in the group inflated it: "trigify-app 2" over one row.
  it("holds split members out of their repo groups entirely", () => {
    renderSidebar(crossRepo)
    expect(rowOrder()).toStrictEqual(["loose"])
    // gtm-grid's only session is in the split, so the heading goes with it
    // rather than sitting over an empty list.
    expect(screen.queryByText("gtm-grid")).toBeNull()
    expect(screen.getByText("trigify-app")).toBeDefined()
  })

  it("shows no splits section when nothing is split", () => {
    render(
      <SessionSidebar
        activeSessionId="loose"
        onSelect={() => {}}
        sessions={[session({ id: "loose", title: "Loose end", repo: "trigify-app" })]}
        defaultFilters={DEFAULT_FILTERS}
      />
    )
    expect(screen.queryByText("Split")).toBeNull()
    expect(screen.queryByText("Splits")).toBeNull()
  })
})

describe("SessionSidebar persistent tray", () => {
  it("promotes an ordinary active row through its context menu", () => {
    const onSetPersistent = vi.fn()
    render(
      <SessionSidebar
        activeSessionId="ordinary"
        onSelect={() => {}}
        onSetPersistent={onSetPersistent}
        sessions={[session({ id: "ordinary", title: "Ordinary session" })]}
        defaultFilters={DEFAULT_FILTERS}
      />
    )

    fireEvent.contextMenu(screen.getByTestId("session-row-ordinary"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Persist" }))
    expect(onSetPersistent).toHaveBeenCalledWith("ordinary", true)
  })

  it("renders active persistent sessions once in the fixed tray", () => {
    const onSelect = vi.fn()
    render(
      <SessionSidebar
        activeSessionId="kept"
        onSelect={onSelect}
        sessions={[
          session({ id: "kept", title: "Kept session", persistent: true }),
          session({ id: "ordinary", title: "Ordinary session" })
        ]}
        defaultFilters={DEFAULT_FILTERS}
      />
    )

    expect(screen.getByTestId("persistent-session-tile-kept")).toBeDefined()
    expect(
      screen.getByTestId("persistent-session-tray").className
    ).toContain("overflow-y-auto")
    expect(screen.queryByTestId("session-row-kept")).toBeNull()
    expect(screen.getByTestId("session-row-ordinary")).toBeDefined()
    expect(screen.queryByTestId("persistent-session-add")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Kept session" }))
    expect(onSelect).toHaveBeenCalledWith("kept")
  })

  it("shows one tray add tile when no active session is persistent", () => {
    const onNewSession = vi.fn()
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        onNewSession={onNewSession}
        sessions={[]}
        defaultFilters={DEFAULT_FILTERS}
      />
    )

    const tray = screen.getByTestId("persistent-session-tray")
    expect(tray.querySelectorAll("[data-testid='persistent-session-add']")).toHaveLength(1)
    fireEvent.click(screen.getByTestId("persistent-session-add"))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it("keeps archived persistent sessions out of the tray and returns them after restoration", () => {
    const onRestore = vi.fn()
    const archived = session({
      id: "kept",
      title: "Kept session",
      persistent: true,
      archived: true,
      archiveReason: "closed",
      archivedAt: "2026-07-18T08:00:00.000Z"
    })
    const view = render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        onRestore={onRestore}
        sessions={[archived]}
        defaultFilters={{ ...DEFAULT_FILTERS, status: "archived" }}
      />
    )

    expect(screen.queryByTestId("persistent-session-tile-kept")).toBeNull()
    expect(screen.getByTestId("session-row-kept")).toBeDefined()
    fireEvent.contextMenu(screen.getByTestId("session-row-kept"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }))
    expect(onRestore).toHaveBeenCalledWith("kept")

    view.rerender(
      <SessionSidebar
        activeSessionId="kept"
        onSelect={() => {}}
        onRestore={onRestore}
        sessions={[session({ id: "kept", title: "Kept session", persistent: true })]}
        defaultFilters={{ ...DEFAULT_FILTERS, status: "archived" }}
      />
    )
    expect(screen.getByTestId("persistent-session-tile-kept")).toBeDefined()
    expect(screen.queryByTestId("session-row-kept")).toBeNull()
  })

  it("keeps the persistent tray visible while ordinary rows are filtered", () => {
    render(
      <SessionSidebar
        activeSessionId="kept"
        onSelect={() => {}}
        sessions={[
          session({ id: "kept", title: "Kept session", repo: "jingler", persistent: true }),
          session({ id: "other", title: "Other repo", repo: "elsewhere" })
        ]}
        defaultFilters={{ ...DEFAULT_FILTERS, repo: "elsewhere" }}
      />
    )

    expect(screen.getByTestId("persistent-session-tile-kept")).toBeDefined()
    expect(screen.getByTestId("session-row-other")).toBeDefined()
    expect(screen.queryByTestId("session-row-kept")).toBeNull()
  })
})
