import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_FILTERS } from "./session-filters.js"
import { SessionSidebar } from "./session-sidebar.js"
import type { SplitGroup } from "./split-layout.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)
let canvasContext: { mockRestore: () => void }
beforeAll(() => {
  canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null)
})
afterAll(() => canvasContext.mockRestore())

const rowOrder = () =>
  Array.from(document.querySelectorAll("[data-testid^='session-row-']")).map((el) =>
    el.getAttribute("data-testid")!.replace("session-row-", "")
  )

describe("SessionSidebar session identity", () => {
  it("renders persistent data as an ordinary session without pin controls", () => {
    const select = vi.fn()
    render(<SessionSidebar activeSessionId={null} onSelect={select}
      onArchive={() => {}} sessions={[session({ id: "legacy", persistent: true })]}
      defaultFilters={DEFAULT_FILTERS} />)
    const row = screen.getByTestId("session-row-legacy")
    fireEvent.click(row)
    expect(select).toHaveBeenCalledWith("legacy")
    fireEvent.contextMenu(row)
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Persist" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull()
  })

  it("renders global search above the session list", () => {
    render(
      <SessionSidebar
        activeSessionId="local"
        onSelect={() => {}}
        sessions={[session({ id: "local" })]}
        search={<button type="button">Search sessions and actions</button>}
      />
    )

    const search = screen.getByRole("button", { name: "Search sessions and actions" })
    const row = screen.getByTestId("session-row-local")
    expect(search.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it("keeps an in-flight remote session navigable before it is persisted", () => {
    const selectPending = vi.fn()
    render(
      <SessionSidebar
        activeSessionId="local"
        onSelect={() => {}}
        sessions={[session({ id: "local" })]}
        pendingEnvironmentSession={{
          id: "pending-environment-session",
          title: "Prepare on buildbox",
          repo: "jingler",
          environmentId: "device-buildbox",
          environmentName: "buildbox",
          environmentKind: "owned",
          phase: "resolving-repository",
          error: null
        }}
        onSelectPendingEnvironmentSession={selectPending}
      />
    )

    const row = screen.getByTestId("pending-environment-session")
    expect(row.textContent).toContain("Prepare on buildbox")
    expect(row.textContent).toContain("Starting on buildbox · jingler")
    fireEvent.click(row)
    expect(selectPending).toHaveBeenCalledOnce()
  })

  it("reflects the composer-selected environment in the session row", () => {
    render(
      <SessionSidebar
        activeSessionId="remote"
        onSelect={() => {}}
        sessions={[session({ id: "remote", environmentId: "device-buildbox" })]}
        environments={[{
          kind: "owned",
          id: "device-buildbox", name: "buildbox", platform: { os: "darwin", arch: "arm64" },
          capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 4 },
          state: "offline", agentVersion: "2.0.3", lastSeenAt: 1
        }]}
      />
    )
    expect(screen.getByTestId("session-environment-remote").textContent).toBe("buildbox · offline")
    expect(screen.getByTestId("session-location-remote").getAttribute("title")).toBe("Environment: buildbox · offline")
  })
  it("shows repository, attention age, PR, execution location, and status", () => {
    render(
      <SessionSidebar
        activeSessionId="cloud-run"
        onSelect={() => {}}
        sessions={[
          session({
            id: "cloud-run",
            repo: "jingler",
            title: "Liquid glass sidebar",
            status: "running",
            executionLocation: "cloud",
            prNumber: 5462
          })
        ]}
        liveActivity={{
          "cloud-run": {
            kind: "running",
            verb: "Running",
            target: "pnpm test",
            startedAt: Date.now() - 13 * 60_000
          }
        }}
        repoOwners={{ "cloud-run": "jinglerhq" }}
      />
    )

    expect(screen.getByText("jingler")).toBeTruthy()
    expect(screen.getByText("Running 13m")).toBeTruthy()
    expect(screen.getByText("#5462")).toBeTruthy()
    expect(screen.getByTestId("session-location-cloud-run").getAttribute("title")).toBe(
      "Cloud session"
    )
    expect(screen.getByRole("status", { name: "Running" })).toBeTruthy()
    expect(screen.getByAltText("j").getAttribute("src")).toContain("github.com/jinglerhq.png")
  })

  it("disables a row and shows a breathing indicator while archiving", async () => {
    let finishArchive!: () => void
    const pendingArchive = new Promise<void>((resolve) => {
      finishArchive = resolve
    })
    const archive = vi.fn(() => pendingArchive)
    const select = vi.fn()
    render(
      <SessionSidebar
        activeSessionId="pending"
        onSelect={select}
        onArchive={archive}
        sessions={[session({ id: "pending", title: "Pending archive" })]}
      />
    )

    fireEvent.click(screen.getByTitle("Archive Pending archive"))
    const row = screen.getByTestId("session-row-pending")
    expect(row.getAttribute("aria-busy")).toBe("true")
    expect(screen.getByRole("status", { name: "Archiving session…" })).toBeTruthy()
    fireEvent.click(row)
    expect(select).not.toHaveBeenCalled()

    finishArchive()
    await waitFor(() =>
      expect(screen.getByTestId("session-row-pending").getAttribute("aria-busy")).toBe("false")
    )
  })

  it("keeps the collapsed rail integrated with the app background", () => {
    window.localStorage.setItem("sb.sidebar.pinned", "0")
    render(
      <SessionSidebar
        activeSessionId={null}
        onSelect={() => {}}
        sessions={[session({ id: "rail" })]}
      />
    )

    const rail = screen.getByTestId("session-rail")
    expect(rail.className).not.toContain("rounded-2xl")
    expect(rail.className).not.toContain("backdrop-blur-2xl")
    expect(rail.className).not.toContain("bg-panel")
    localStorage.removeItem("sb.sidebar.pinned")
  })
})

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

describe("SessionSidebar global destinations", () => {
  it("opens and marks Pull Requests active", () => {
    const open = vi.fn()
    render(
      <SessionSidebar
        activeSessionId="session"
        onSelect={() => {}}
        sessions={[session({ id: "session" })]}
        pullRequestsActive
        onOpenPullRequests={open}
      />
    )
    fireEvent.click(screen.getByTestId("pull-requests-sidebar-item"))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("pull-requests-sidebar-item").getAttribute("aria-current")).toBe("page")
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

describe("SessionSidebar updates", () => {
  it("starts the download from the upgrade card and collapses to an icon when dismissed", () => {
    localStorage.removeItem("sb.sidebar.pinned")
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    const update = {
      version: "1.2.3",
      status: "available" as const,
      dismissed: false,
      onAction,
      onDismiss
    }
    const { rerender } = render(
      <SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
        defaultFilters={DEFAULT_FILTERS} update={update} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Download Jingler 1.2.3" }))
    expect(onAction).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Jingler 1.2.3 update" }))
    expect(onDismiss).toHaveBeenCalledOnce()

    rerender(
      <SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
        defaultFilters={DEFAULT_FILTERS} update={{ ...update, dismissed: true }} />
    )
    expect(screen.getByTitle("Download Jingler 1.2.3")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Dismiss Jingler 1.2.3 update" })).toBeNull()
  })

  it("shows download progress and the restart action", () => {
    localStorage.removeItem("sb.sidebar.pinned")
    const base = { version: "1.2.3", dismissed: false, onAction: () => {}, onDismiss: () => {} }
    const { rerender } = render(
      <SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
        defaultFilters={DEFAULT_FILTERS} update={{ ...base, status: "downloading", percent: 42 }} />
    )
    expect(screen.getByText("Downloading 42%")).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "Update download progress" }).getAttribute("aria-valuenow")).toBe("42")
    expect(screen.getByText("Downloading the update in the background.")).toBeTruthy()

    rerender(
      <SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
        defaultFilters={DEFAULT_FILTERS} update={{ ...base, status: "downloaded" }} />
    )
    expect(screen.getByText("Restart to update")).toBeTruthy()
  })
})

describe("SessionSidebar optional sign-in", () => {
  const openAccountMenu = () =>
    fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), { key: "Enter" })

  it("keeps Settings reachable and offers Sign in from the menu while signed out", () => {
    const signIn = vi.fn()
    const settings = vi.fn()
    render(<SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
      defaultFilters={DEFAULT_FILTERS} onSignIn={signIn} onOpenSettings={settings} version="1.2.3" />)
    expect(screen.getByRole("button", { name: "Account menu" }).textContent).toContain("Not signed in")
    openAccountMenu()
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }))
    expect(signIn).toHaveBeenCalledOnce()
  })

  it("offers Sign out, not Sign in, once a user is signed in", () => {
    render(<SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
      defaultFilters={DEFAULT_FILTERS} onSignIn={() => {}} onSignOut={() => {}}
      user={{ id: "u1", name: "Ada", email: "ada@example.com", image: null }} />)
    expect(screen.getByRole("button", { name: "Account menu" }).textContent).toContain("Ada")
    openAccountMenu()
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull()
  })

  it("offers neither while the stored session is still being checked", () => {
    render(<SessionSidebar activeSessionId={null} onSelect={() => {}} sessions={[]}
      defaultFilters={DEFAULT_FILTERS} onOpenSettings={() => {}} />)
    expect(screen.getByRole("button", { name: "Account menu" }).textContent).not.toContain("Not signed in")
    openAccountMenu()
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull()
  })
})

describe("SessionSidebar release notes", () => {
  const notes = ["One", "Two", "Three", "Four", "Five", "Six"]

  it("says which version it updated to and lists the first changes", () => {
    const onDismiss = vi.fn()
    render(
      <SessionSidebar
        sessions={[]}
        activeSessionId={null}
        onSelect={() => {}}
        releaseNotes={{ version: "0.3.0", notes, onDismiss }}
      />
    )
    const card = screen.getByRole("region", { name: "Updated to Jingler 0.3.0" })
    expect(within(card).getByText("Four")).toBeTruthy()
    expect(within(card).queryByText("Five")).toBeNull()
    expect(within(card).getByText("and 2 more changes")).toBeTruthy()

    fireEvent.click(within(card).getByRole("button", { name: "Dismiss Jingler 0.3.0 release notes" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("renders nothing when there is nothing new", () => {
    render(<SessionSidebar sessions={[]} activeSessionId={null} onSelect={() => {}} />)
    expect(screen.queryByTestId("release-notes-card")).toBeNull()
  })
})

const CANNOT_SELF_UPDATE = /can't update itself/

describe("SessionSidebar manual updates", () => {
  it("offers the installer when the build cannot update itself", () => {
    const onAction = vi.fn()
    render(
      <SessionSidebar
        sessions={[]}
        activeSessionId={null}
        onSelect={() => {}}
        update={{ version: "0.3.4", status: "available", manual: true, dismissed: false, onAction, onDismiss: () => {} }}
      />
    )
    expect(screen.getByText("Download installer")).toBeTruthy()
    expect(screen.getByText(CANNOT_SELF_UPDATE)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Download the Jingler 0.3.4 installer" }))
    expect(onAction).toHaveBeenCalledOnce()
  })
})
