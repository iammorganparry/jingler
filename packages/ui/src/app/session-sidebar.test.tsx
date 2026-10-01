import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_FILTERS } from "./session-filters.js"
import { SessionSidebar } from "./session-sidebar.js"
import { testSession as session } from "../test-support.js"
import { allTabs, dropTab, focusedGroup, openTab } from "./editor-layout.js"
import { editorLayoutOf, resetEditorLayouts, updateEditorLayout } from "./editor-layout-machine.js"

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

describe("SessionSidebar session tree", () => {
  const two = [
    session({
      id: "s1",
      chats: [
        { id: "c1", title: "Main chat", createdAt: "now", updatedAt: "now", providerId: "anthropic" as never },
        { id: "c2", title: "Side chat", createdAt: "now", updatedAt: "now" }
      ],
      activeChatId: "c1"
    }),
    session({ id: "s2" })
  ]
  const renderTree = (props: Partial<Parameters<typeof SessionSidebar>[0]> = {}) =>
    render(<SessionSidebar activeSessionId="s1" onSelect={() => {}} sessions={two} {...props} />)

  beforeEach(() => {
    localStorage.clear()
    resetEditorLayouts()
  })

  it("always shows the active session's chats, with each chat's provider icon", () => {
    renderTree()
    const tree = screen.getByTestId("session-tree-s1")
    expect(within(tree).getByText("Main chat")).toBeTruthy()
    expect(within(tree).getByText("Side chat")).toBeTruthy()
    expect(within(tree).getByTitle("Anthropic")).toBeTruthy()
    expect(screen.queryByTestId("session-tree-s2")).toBeNull()
  })

  it("expands another session from its chevron without selecting it, and remembers it", () => {
    const select = vi.fn()
    const { unmount } = renderTree({ onSelect: select })
    fireEvent.click(screen.getByTestId("session-expand-s2"))
    expect(screen.getByTestId("session-tree-s2")).toBeTruthy()
    expect(select).not.toHaveBeenCalled()
    unmount()
    renderTree()
    expect(screen.getByTestId("session-tree-s2")).toBeTruthy()
  })

  it("opens a chat as a tab and selects its session; closes it everywhere from the sidebar", () => {
    const select = vi.fn()
    renderTree({ onSelect: select })
    fireEvent.click(within(screen.getByTestId("session-tree-chat-c2")).getByText("Side chat"))
    expect(select).toHaveBeenCalledWith("s1")
    expect(allTabs(editorLayoutOf("s1")!).map((t) => t.id)).toContain("c2")
    fireEvent.click(screen.getByRole("button", { name: "Close Side chat everywhere" }))
    expect(allTabs(editorLayoutOf("s1")!).map((t) => t.id)).not.toContain("c2")
    // Chats stay listed after closing; only files and views drop out.
    expect(screen.getByTestId("session-tree-chat-c2")).toBeTruthy()
  })

  it("lists open files and session views, and closes files only after the editor allows it", () => {
    const requestClose = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    renderTree({ onRequestCloseFile: requestClose })
    fireEvent.click(within(screen.getByTestId("session-tree-chat-c1")).getByText("Main chat"))
    act(() =>
      updateEditorLayout("s1", (l) => openTab(openTab(l, { kind: "file", id: "src/a.ts" }), { kind: "view", id: "terminal" }))
    )
    expect(screen.getByText("Files")).toBeTruthy()
    expect(screen.getByTestId("session-tree-file-src/a.ts")).toBeTruthy()
    expect(screen.getByTestId("session-tree-view-terminal")).toBeTruthy()
    act(() =>
      updateEditorLayout("s1", (layout) =>
        dropTab(
          layout,
          { surface: { kind: "view", id: "terminal" } },
          focusedGroup(layout)?.id ?? null,
          "bottom",
          true
        )
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal everywhere" }))
    expect(allTabs(editorLayoutOf("s1")!).map((tab) => tab.id)).not.toContain("terminal")
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts everywhere" }))
    expect(requestClose).toHaveBeenCalledWith("s1", "src/a.ts")
    expect(screen.getByTestId("session-tree-file-src/a.ts")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts everywhere" }))
    expect(screen.queryByTestId("session-tree-file-src/a.ts")).toBeNull()
  })

  it("shows no tree in the collapsed rail", () => {
    renderTree({ forceCollapsed: true })
    expect(screen.queryByTestId("session-tree-s1")).toBeNull()
  })
})
