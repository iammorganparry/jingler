import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Boxes } from "lucide-react"
import type { Session } from "@jingler/core"
import { SessionPane } from "./session-pane.js"
import { LinearMark } from "../components/linear-mark.js"
import {
  builtinTabContributions,
  PLUGIN_TAB_ORDER,
  type TabContribution,
  visibleTabs
} from "../app/tab-contributions.js"
import { testSession as session } from "../test-support.js"
import { SESSION_SURFACE_COMMAND_EVENT } from "../app/session-surface-layout.js"
import { editorTabMime } from "../app/editor-groups.js"
import { resetEditorLayouts } from "../app/editor-layout-machine.js"

beforeEach(() => {
  localStorage.clear()
  resetEditorLayouts()
})
afterEach(cleanup)

const SECOND_LINEAR_ISSUE = /ENG-2 Second issue/

/** The built-ins with inert bodies — these tests are about which tabs, not what's in them. */
const BUILTINS = builtinTabContributions({
  conversation: () => null,
  stub: () => null
})

const idsFor = (
  s: Session,
  opts: { hasPlan?: boolean; hasExplanation?: boolean; extra?: ReadonlyArray<TabContribution> } = {}
) =>
  visibleTabs(
    {
      session: s,
      hasPlan: opts.hasPlan ?? false,
      hasExplanation: opts.hasExplanation ?? false
    },
    [...BUILTINS, ...(opts.extra ?? [])]
  ).map((c) => c.id)

/** A minimal plugin-shaped contribution. */
const pluginTab = (
  id: string,
  over: Partial<TabContribution> = {}
): TabContribution => ({
  id,
  label: id,
  icon: Boxes,
  order: PLUGIN_TAB_ORDER,
  when: () => true,
  render: () => <div>{id} body</div>,
  ...over
})

const mockPaneWidth = (width: number) =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: 800,
    left: 0,
    width,
    height: 800,
    toJSON: () => ({})
  })



describe("visibleTabs", () => {
  it("shows only Conversation for a bare session", () => {
    expect(idsFor(session({ id: "a", worktreePath: undefined }))).toEqual([
      "conversation"
    ])
  })

  it("no longer has a built-in Issue tab — that shipped as a plugin", () => {
    // The Issue tab is `github-issues`, an official plugin. Nothing built-in
    // claims it, which is what makes the migration real rather than cosmetic.
    expect(idsFor(session({ id: "a", issueNumber: 7 }))).not.toContain("issue")
  })

  it("lets a plugin claim the Issue slot at the order the built-in used", () => {
    // `github-issues` declares order 10, so the migration is invisible to an
    // operator who was already using the tab: same place, same label.
    const ids = idsFor(session({ id: "a", issueNumber: 7 }), {
      extra: [
        pluginTab("github-issues.issue", {
          order: 10,
          when: ({ session: s }) => s.issueNumber != null
        })
      ]
    })
    expect(ids[1]).toBe("github-issues.issue")
  })

  it("shows Plan only while an embedded review is active", () => {
    const s = session({ id: "a" })
    expect(idsFor(s, { hasPlan: false })).not.toContain("plan")
    expect(idsFor(s, { hasPlan: true })).toContain("plan")
  })

  it("shows Explanation only when a published artifact is present", () => {
    const s = session({ id: "a" })
    expect(idsFor(s, { hasExplanation: false })).not.toContain("explanation")
    expect(idsFor(s, { hasExplanation: true })).toContain("explanation")
  })

  it("shows Files only for worktree-backed sessions", () => {
    expect(idsFor(session({ id: "a" }))).toContain("files")
    expect(idsFor(session({ id: "b", worktreePath: undefined }))).not.toContain("files")
  })

  it("offers one Changes action for local and PR sessions alike", () => {
    expect(idsFor(session({ id: "a" }))).toContain("changes")
    expect(idsFor(session({ id: "a", prNumber: 12 }))).toContain("changes")
    // Code Review merged into the Explorer's changed-files filter.
    expect(idsFor(session({ id: "a", prNumber: 12 }))).not.toContain("review")
  })

  it("keeps the built-in order the operator already knows", () => {
    expect(idsFor(session({ id: "a", issueNumber: 7 }), { hasPlan: true })).toEqual([
      "conversation",
      "files",
      "plan",
      "pr",
      "changes"
    ])
  })

  it("sorts plugin tabs after the built-ins by default", () => {
    const ids = idsFor(session({ id: "a" }), { extra: [pluginTab("linear.issues")] })
    expect(ids.at(-1)).toBe("linear.issues")
  })

  it("orders two same-order plugin tabs deterministically rather than by load order", () => {
    // Two plugins both defaulting to PLUGIN_TAB_ORDER must not swap places
    // between renders depending on which finished loading first.
    const forward = idsFor(session({ id: "a" }), {
      extra: [pluginTab("zeta.one"), pluginTab("alpha.one")]
    })
    const reversed = idsFor(session({ id: "a" }), {
      extra: [pluginTab("alpha.one"), pluginTab("zeta.one")]
    })
    expect(forward).toEqual(reversed)
    expect(forward.indexOf("alpha.one")).toBeLessThan(forward.indexOf("zeta.one"))
  })

  it("lets a plugin sort itself between built-ins when it asks to", () => {
    const ids = idsFor(session({ id: "a" }), {
      extra: [pluginTab("early.tab", { order: 5 })]
    })
    expect(ids.indexOf("early.tab")).toBe(1)
  })

  it("skips a contribution whose `when` throws instead of taking the pane down", () => {
    // `when` is third-party code evaluated during render. One careless plugin
    // must cost itself a tab, not blank the app.
    const ids = idsFor(session({ id: "a" }), {
      extra: [
        pluginTab("bad.tab", {
          when: () => {
            throw new Error("boom")
          }
        }),
        pluginTab("good.tab")
      ]
    })
    expect(ids).not.toContain("bad.tab")
    expect(ids).toContain("good.tab")
    expect(ids).toContain("conversation")
  })

  it("returns nothing when there is no session to reason about", () => {
    expect(visibleTabs(null, BUILTINS)).toEqual([])
  })
})

/*
 * A note on `getByRole("button", { name })` rather than `getByText` for tabs.
 *
 * The tab-chrome redesign made non-conversation tabs glyph-first: the text label
 * is rendered only while that tab is selected, and only from the `mid` width tier
 * up. So `getByText("Pull Request")` cannot find a tab you have not clicked yet —
 * which is every tab, at the moment you want to click it.
 *
 * The accessible name survives on purpose (`aria-label` + `title` on every glyph),
 * so querying by it is both what a screen-reader user does and the only spelling
 * that is stable across tiers.
 */
describe("debug source following", () => {
  it("opens Files for every new debugger stop sequence", () => {
    const props = {
      session: session({ id: "debug", worktreePath: "/repo" }),
      renderConversation: () => <div>transcript</div>,
      renderFiles: () => <div>debug source</div>
    }
    const view = render(<SessionPane {...props} debugStopSequence={0} />)
    expect(screen.getByText("transcript")).toBeTruthy()
    view.rerender(<SessionPane {...props} debugStopSequence={1} />)
    expect(screen.getByText("debug source")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Chat 1" }))
    view.rerender(<SessionPane {...props} debugStopSequence={2} />)
    expect(screen.getByText("debug source")).toBeTruthy()
  })
})

describe("plugin tab contributions", () => {
  it("renders a plugin tab body through the same path as a built-in", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        tabContributions={[pluginTab("linear.issues")]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "linear.issues" }))
    expect(screen.getByText("linear.issues body")).toBeTruthy()
  })

  it("passes a right-rail picker through to a plugin tab", () => {
    const onSelect = vi.fn()
    render(
      <SessionPane
        session={session({ id: "linear-menu" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[pluginTab("linear.issue", { label: "Linear", icon: LinearMark })]}
        viewRailMenus={{
          "linear.issue": {
            value: "issue-1",
            ariaLabel: "Select linked Linear issue",
            onSelect,
            options: [
              { value: "issue-1", label: "ENG-1", description: "First issue", ariaLabel: "ENG-1 First issue" },
              { value: "issue-2", label: "ENG-2", description: "Second issue", ariaLabel: "ENG-2 Second issue" }
            ]
          }
        }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Select linked Linear issue" }))
    fireEvent.click(screen.getByRole("option", { name: SECOND_LINEAR_ISSUE }))
    expect(onSelect).toHaveBeenCalledWith("issue-2")
    expect(screen.getByText("linear.issue body")).toBeTruthy()
  })

  it("derives a provider issue picker and persists the chosen issue", () => {
    const onSelectIssue = vi.fn()
    render(
      <SessionPane
        session={session({
          id: "linear-derived-menu",
          linkedIssues: [
            {
              providerId: "linear",
              providerAccountId: "work",
              id: "issue-1",
              identifier: "ENG-1",
              title: "First issue",
              url: "https://linear.app/issue/ENG-1",
              labels: []
            },
            {
              providerId: "linear",
              providerAccountId: "personal",
              id: "issue-2",
              identifier: "ENG-2",
              title: "Second issue",
              url: "https://linear.app/issue/ENG-2",
              labels: []
            }
          ],
          selectedIssue: { providerId: "linear", id: "issue-1" }
        })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[
          pluginTab("linear.issue", {
            label: "Linear",
            icon: LinearMark,
            issueProviderId: "linear"
          })
        ]}
        onSelectIssue={onSelectIssue}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Select linked Linear issue" }))
    fireEvent.click(screen.getByRole("option", { name: SECOND_LINEAR_ISSUE }))
    expect(onSelectIssue).toHaveBeenCalledWith("linear-derived-menu", {
      providerId: "linear",
      providerAccountId: "personal",
      id: "issue-2"
    })
    expect(screen.getByText("linear.issue body")).toBeTruthy()
  })

  it("opens a provider tab directly when it has only one linked issue", () => {
    render(
      <SessionPane
        session={session({
          id: "linear-single",
          linkedIssues: [{
            providerId: "linear",
            id: "issue-1",
            identifier: "ENG-1",
            title: "Only issue",
            url: "https://linear.app/issue/ENG-1",
            labels: []
          }],
          selectedIssue: { providerId: "linear", id: "issue-1" }
        })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[
          pluginTab("linear.issue", {
            label: "Linear",
            icon: LinearMark,
            issueProviderId: "linear"
          })
        ]}
        onSelectIssue={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Linear" }))
    expect(screen.getByText("linear.issue body")).toBeTruthy()
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("draws a plugin's own badge without the tab bar knowing what it means", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[
          pluginTab("linear.issues", {
            badge: () => ({ kind: "count", text: "12" })
          })
        ]}
      />
    )
    expect(screen.getByText("12")).toBeTruthy()
  })

  it("survives a plugin whose badge throws", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[
          pluginTab("linear.issues", {
            badge: () => {
              throw new Error("boom")
            }
          })
        ]}
      />
    )
    expect(screen.getByText("transcript")).toBeTruthy()
    expect(screen.getByRole("button", { name: "linear.issues" })).toBeTruthy()
  })

  it("falls back off a plugin tab when its plugin is disabled mid-session", () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[pluginTab("linear.issues")]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "linear.issues" }))
    expect(screen.getByText("linear.issues body")).toBeTruthy()

    rerender(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[]}
      />
    )
    expect(screen.queryByText("linear.issues body")).toBeNull()
    expect(screen.getByText("transcript")).toBeTruthy()
  })
})

describe("session browser tab", () => {
  it("opens inside its owning session pane and keeps the view tab open when conversation is selected", () => {
    const toggled: string[] = []
    const BrowserHarness = () => {
      const [open, setOpen] = useState(false)
      return (
        <SessionPane
          session={session({ id: "browser-owner" })}
          renderConversation={() => <div>owner transcript</div>}
          renderBrowser={(owner) => <div>browser for {owner.id}</div>}
          isBrowserActive={() => open}
          onToggleBrowser={(sessionId) => {
            toggled.push(sessionId)
            setOpen((current) => !current)
          }}
        />
      )
    }

    render(<BrowserHarness />)
    fireEvent.click(screen.getByRole("button", { name: "Browser" }))
    expect(screen.getByText("browser for browser-owner")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Chat 1" }))
    expect(screen.getByText("owner transcript")).toBeTruthy()
    expect(toggled).toEqual(["browser-owner"])
  })

  it("turns a chat-owned browser off when its tab closes", () => {
    const owner = session({ id: "browser-owner" })
    const onToggleBrowser = vi.fn()
    render(
      <SessionPane
        session={owner}
        renderConversation={() => <div>owner transcript</div>}
        renderBrowser={() => <div>browser</div>}
        isBrowserActive={() => true}
        onToggleBrowser={onToggleBrowser}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Browser" }))
    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }))
    expect(onToggleBrowser).toHaveBeenCalledWith("browser-owner", owner.activeChatId)
  })

  it("opens the owning browser tab when an agent reveals it", () => {
    const props = {
      session: session({ id: "agent-owner" }),
      renderConversation: () => <div>agent transcript</div>,
      renderBrowser: (owner: Session) => <div>agent browser for {owner.id}</div>,
      onToggleBrowser: vi.fn(),
      isBrowserActive: () => false
    }
    const { rerender } = render(<SessionPane {...props} />)
    expect(screen.getByText("agent transcript")).toBeTruthy()

    rerender(<SessionPane {...props} isBrowserActive={() => true} />)
    expect(screen.getByText("agent browser for agent-owner")).toBeTruthy()
  })
})

describe("mount groups", () => {
  it("navigates to Explanation as a tab in the focused group", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        explanationSessions={new Set(["a"])}
        renderConversation={() => <span>conversation body</span>}
        renderExplanation={() => <span>explanation body</span>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Explanation" }))
    expect(screen.getByText("explanation body")).toBeTruthy()
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
    expect(screen.getByTestId("editor-body-view-explanation").hidden).toBe(false)
  })

  it("opens Plan Review as a view tab when the pane is roomy", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={(_session, view) => (
          <span data-testid="plan-presentation">{view}</span>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent)).toContain("plan")
  })

  it("does not carry an open Plan screen into another agent tab", () => {
    const first = session({
      id: "a",
      chats: [
        { id: "chat-a", title: "Agent A", createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" },
        { id: "chat-b", title: "Agent B", createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" }
      ],
      activeChatId: "chat-a"
    })
    const rendered = render(
      <SessionPane
        session={first}
        planSessions={new Set(["chat-a", "chat-b"])}
        renderConversation={(owner, view) => (
          <span data-testid="plan-presentation">{owner.activeChatId}:{view}</span>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent))
      .toContain("chat-a:plan")

    rendered.rerender(<SessionPane
      session={{ ...first, activeChatId: "chat-b" }}
      planSessions={new Set(["chat-a", "chat-b"])}
      renderConversation={(owner, view) => (
        <span data-testid="plan-presentation">{owner.activeChatId}:{view}</span>
      )}
    />)
    const presentations = screen.getAllByTestId("plan-presentation").map((node) => node.textContent)
    expect(presentations).toContain("chat-a:plan")
    expect(presentations).toContain("chat-b:conversation")
    expect(presentations).not.toContain("chat-b:plan")
  })

  it("keeps a focused chat-owned Plan surface when its owner becomes active", () => {
    const owner = session({
      id: "a",
      chats: [
        { id: "chat-a", title: "Agent A", createdAt: "now", updatedAt: "now" },
        { id: "chat-b", title: "Agent B", createdAt: "now", updatedAt: "now" }
      ],
      activeChatId: "chat-b"
    })
    localStorage.setItem(
      "sb.session-surfaces.v1:a",
      JSON.stringify({
        panes: [
          { surface: { kind: "chat", id: "chat-b" }, ratio: 0.5 },
          { surface: { kind: "view", id: "plan", chatId: "chat-a" }, ratio: 0.5 }
        ],
        focused: 1,
        openViews: [{ kind: "view", id: "plan", chatId: "chat-a" }]
      })
    )
    const rendered = render(
      <SessionPane
        session={owner}
        planSessions={new Set(["chat-a"])}
        renderConversation={(_session, view) => <div>{view}</div>}
      />
    )

    rendered.rerender(
      <SessionPane
        session={{ ...owner, activeChatId: "chat-a" }}
        planSessions={new Set(["chat-a"])}
        renderConversation={(_session, view) => <div>{view}</div>}
      />
    )

    const focusedGroup = screen.getAllByTestId("editor-group").find((group) => group.dataset.focused)!
    expect(within(focusedGroup).getByRole("tab", { selected: true }).textContent).toContain("Plan")
  })

  it("hides Plan Review when no embedded review is active", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set()}
      />
    )

    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull()
  })

  it("opens the first streamed draft as a view tab", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        // Promotion has not happened yet, so the canonical plan index does not
        // include the session when its first renderable draft arrives.
        planSessions={new Set()}
        renderConversation={(_session, view, ctx) => (
          <div>
            <button onClick={ctx.onPlanDraftAvailable}>stream draft</button>
            <span data-testid="plan-presentation">{view}</span>
          </div>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "stream draft" }))
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent)).toContain("plan")
  })

  it("stacks streamed Plan Review while two readable panes still fit", async () => {
    const rect = mockPaneWidth(600)
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={(_session, view, ctx) => (
          <div>
            <button onClick={ctx.onPlanDraftAvailable}>stream draft</button>
            <span data-testid="plan-presentation">{view}</span>
          </div>
        )}
      />
    )

    await screen.findByRole("button", { name: "stream draft" })
    fireEvent.click(screen.getByRole("button", { name: "stream draft" }))
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent)).toContain("plan")
    rect.mockRestore()
  })

  it("stacks manually selected Plan Review while two readable panes still fit", async () => {
    const rect = mockPaneWidth(600)
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={(_session, view) => (
          <span data-testid="plan-presentation">{view}</span>
        )}
      />
    )

    await screen.findByRole("button", { name: "Plan" })
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent)).toContain("plan")
    rect.mockRestore()
  })

  it("opens Plan as a tab while the transcript stays mounted", async () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={(_session, view) => (
          <span data-testid="plan-presentation">{view}</span>
        )}
      />
    )

    await screen.findByRole("button", { name: "Plan" })
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
    expect(screen.getAllByTestId("plan-presentation").map((node) => node.textContent)).toEqual(["conversation", "plan"])
  })

  it("keeps Conversation mounted while Plan opens beside it", () => {
    const onMount = vi.fn()
    const Body = () => {
      useEffect(() => {
        onMount()
      }, [])
      return <div>transcript</div>
    }

    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={() => <Body />}
      />
    )
    expect(onMount).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(onMount).toHaveBeenCalledTimes(2)
  })

  it("keeps already-open panes mounted while focus moves", () => {
    const onMount = vi.fn()
    const Body = () => {
      useEffect(() => {
        onMount()
      }, [])
      return <div>pr view</div>
    }

    render(
      <SessionPane
        session={session({ id: "a", prNumber: 3 })}
        renderConversation={() => <div>transcript</div>}
        renderPullRequest={() => <Body />}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(onMount).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }))
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(onMount).toHaveBeenCalledTimes(1)
  })
})

describe("SessionPane changes review", () => {
  it("reveals the Explorer's changed files instead of opening a Changes view", () => {
    const onRevealChanges = vi.fn()
    render(
      <SessionPane
        session={session({ id: "a", prNumber: 4 })}
        renderConversation={() => <div>transcript</div>}
        onRevealChanges={onRevealChanges}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Changes" }))
    expect(onRevealChanges).toHaveBeenCalledExactlyOnceWith("a")
    expect(screen.getByText("transcript")).toBeTruthy()
    expect(screen.getAllByTestId("editor-group")).toHaveLength(1)
    expect(screen.queryByTestId("editor-tab-view-changes")).toBeNull()
  })

  it("mounts the host's review tray beside the panes", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        renderReviewTray={(s) => <aside>tray for {s.id}</aside>}
      />
    )
    expect(screen.getByText("tray for a")).toBeTruthy()
  })
})

describe("SessionPane", () => {
  it("keeps tabs inside the editor group, out of the window title row", () => {
    render(
      <>
        <div id="session-tab-bar-portal" />
        <SessionPane
          session={session({ id: "a" })}
          renderConversation={() => <div>transcript</div>}
        />
      </>
    )

    expect(document.getElementById("session-tab-bar-portal")!.childElementCount).toBe(0)
    expect(within(screen.getByTestId("editor-group")).getAllByRole("tab")).toHaveLength(1)
  })

  it("moves the focused session view rail into the main frame", () => {
    render(
      <>
        <div id="session-view-rail-portal" />
        <SessionPane
          session={session({ id: "a" })}
          renderConversation={() => <div>transcript</div>}
        />
      </>
    )

    expect(
      within(document.getElementById("session-view-rail-portal")!).getByTestId("view-rail")
    ).toBeTruthy()
    expect(within(screen.getByTestId("editor-groups")).queryByTestId("view-rail")).toBeNull()
  })

  it("moves group focus on mousedown", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        explanationSessions={new Set(["a"])}
        renderConversation={() => <div>transcript</div>}
        renderExplanation={() => <div>explanation</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Explanation" }))
    const [first, second] = screen.getAllByTestId("editor-group")
    expect(second!.dataset.focused).toBe("true")
    fireEvent.mouseDown(first!)
    expect(first!.dataset.focused).toBe("true")
    expect(second!.dataset.focused).toBeUndefined()
  })

  it("does not remount an unchanged transcript when group focus moves", () => {
    const renderConversation = vi.fn(() => <div>transcript</div>)
    const s = session({ id: "memo" })
    const props = { session: s, explanationSessions: new Set([s.id]), renderConversation,
      renderExplanation: () => <div>explanation</div> }
    render(<SessionPane {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Explanation" }))
    const before = renderConversation.mock.calls.length
    const transcript = screen.getByText("transcript")
    fireEvent(window, new CustomEvent(SESSION_SURFACE_COMMAND_EVENT, { detail: "focus-0" }))
    fireEvent(window, new CustomEvent(SESSION_SURFACE_COMMAND_EVENT, { detail: "focus-1" }))
    expect(screen.getByText("transcript")).toBe(transcript)
    expect(renderConversation.mock.calls.length).toBeGreaterThanOrEqual(before)
  })

  it("protects main again after it is closed and dropped back in", async () => {
    const base = session({ id: "reopen" })
    const mainId = base.activeChatId
    const s = { ...base, chats: [...base.chats, { ...base.chats[0]!, id: "b" }], activeChatId: "b" }
    render(<SessionPane session={s} renderConversation={(owner) => <div>chat {owner.activeChatId}</div>} />)
    const stored = () => JSON.parse(localStorage.getItem("sb.editor-layout.v1:reopen")!)
    const mainTab = screen.getByTestId(`editor-tab-chat-${mainId}`)
    fireEvent.click(within(mainTab).getByRole("button", { name: /^Close / }))
    await waitFor(() => expect(stored().mainChatId).toBeNull())
    fireEvent.drop(screen.getByTestId("editor-group"), {
      dataTransfer: {
        types: [editorTabMime("reopen")],
        getData: () => JSON.stringify({ surface: { kind: "chat", id: mainId } })
      }
    })
    expect(screen.getByTestId(`editor-tab-chat-${mainId}`)).toBeTruthy()
    await waitFor(() => expect(stored().mainChatId).toBe(mainId))
  })

  it("keeps main visible when an external chat change follows a queued handoff", () => {
    const s = session({ id: "handoff" })
    const renderConversation = (owner: Session) => <div>chat {owner.activeChatId}</div>
    const { rerender } = render(<SessionPane session={s} renderConversation={renderConversation} />)
    const added = { ...s.chats[0]!, id: "handed-off" }
    rerender(<SessionPane session={{ ...s, chats: [...s.chats, added], activeChatId: added.id }} renderConversation={renderConversation} />)
    expect(screen.getByText(`chat ${s.activeChatId}`)).toBeTruthy()
    expect(screen.getByText(`chat ${added.id}`)).toBeTruthy()
    expect(screen.getByTestId(`editor-tab-chat-${s.activeChatId}`)).toBeTruthy()
    expect(screen.getByTestId(`editor-tab-chat-${added.id}`)).toBeTruthy()
  })

  it("collapses the content pane when its last tab closes", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        explanationSessions={new Set(["a"])}
        renderConversation={() => <div>transcript</div>}
        renderExplanation={() => <div>explanation</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Explanation" }))
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
    const [, second] = screen.getAllByTestId("editor-group")
    fireEvent.click(within(second!).getByRole("button", { name: "Close Explanation" }))
    expect(screen.getAllByTestId("editor-group")).toHaveLength(1)
  })

  it("routes shortcut commands to the focused group", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        explanationSessions={new Set(["a"])}
        renderConversation={() => <div>transcript</div>}
        renderExplanation={() => <div>explanation</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Explanation" }))
    const command = (detail: string) => fireEvent(window, new CustomEvent(SESSION_SURFACE_COMMAND_EVENT, { detail }))

    command("focus-0")
    expect(screen.getAllByTestId("editor-group")[0]!.dataset.focused).toBe("true")
    command("focus-right")
    command("move-left")
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
    command("close")
    expect(screen.queryByTestId("editor-tab-view-explanation")).toBeNull()
  })

  it("renders the Files built-in through the host renderer", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        renderFiles={(s) => <div>files for {s.id}</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    expect(screen.getByText("files for a")).toBeTruthy()
  })

  it("opens Files as a tab while the transcript stays mounted", async () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
        renderFiles={(s) => <div>files for {s.id}</div>}
      />
    )

    await screen.findByRole("button", { name: "Files" })
    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    expect(screen.getByText("files for a")).toBeTruthy()
    expect(screen.getByText("transcript for a")).toBeTruthy()
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
  })

  it("routes a Files code reference to Conversation in the same session pane", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
        renderFiles={(s, ctx) => (
          <button type="button" onClick={ctx.onSelectConversation}>
            forward reference for {s.id}
          </button>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    fireEvent.click(screen.getByRole("button", { name: "forward reference for a" }))

    expect(screen.getByText("transcript for a")).toBeTruthy()
  })

  it("hydrates restored file panes into the host's file tab actor", async () => {
    localStorage.setItem(
      "sb.session-surfaces.v1:a",
      JSON.stringify({
        panes: [{ surface: { kind: "file", id: "src/restored.ts" }, ratio: 1 }],
        focused: 0,
        openViews: []
      })
    )
    const onTrackFile = vi.fn()

    render(
      <SessionPane
        session={session({ id: "a" })}
        renderFiles={() => <div>restored file</div>}
        onTrackFile={onTrackFile}
      />
    )

    await waitFor(() => expect(onTrackFile).toHaveBeenCalledWith("a", "src/restored.ts"))
  })

  it("routes a transcript file gesture into its own editor tab", () => {
    const onTrackFile = vi.fn()
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(_s, _view, ctx) => (
          <button type="button" onClick={() => ctx.onOpenFile("src/main.ts")}>
            open source
          </button>
        )}
        renderFiles={(s, ctx) => <div>files for {s.id}: {ctx.path}</div>}
        onTrackFile={onTrackFile}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "open source" }))

    expect(onTrackFile).toHaveBeenCalledWith("a", "src/main.ts")
    expect(screen.getByText("files for a: src/main.ts")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "main.ts" }).getAttribute("aria-selected")).toBe("true")
  })

  it("renders the session it was given, not one looked up from a list", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
      />
    )
    expect(screen.getByText(/transcript for a/)).toBeTruthy()
  })

  it("keeps tab state independent between two mounted panes", () => {
    // The whole reason for the extraction: a shared `tab` useState in the parent
    // could never let two gridded panes sit on different tabs.
    render(
      <>
        <div data-testid="pane-a">
          <SessionPane
            session={session({ id: "a", prNumber: 1 })}
            renderConversation={(s) => <div>transcript {s.id}</div>}
            renderPullRequest={(s) => <div>pr view {s.id}</div>}
          />
        </div>
        <div data-testid="pane-b">
          <SessionPane
            session={session({ id: "b", prNumber: 2 })}
            renderConversation={(s) => <div>transcript {s.id}</div>}
            renderPullRequest={(s) => <div>pr view {s.id}</div>}
          />
        </div>
      </>
    )

    // Move pane A to its Pull Request tab; pane B must stay on Conversation.
    const paneA = screen.getByTestId("pane-a")
    fireEvent.click(within(paneA).getByRole("button", { name: "Pull Request" }))

    expect(within(paneA).getByText("pr view a")).toBeTruthy()
    expect(within(screen.getByTestId("pane-b")).getByText("transcript b")).toBeTruthy()
  })

  describe("selectTabRequest — the command palette's 'Go to <Tab>'", () => {
    const pane = (props: Record<string, unknown>) => (
      <SessionPane
        session={session({ id: "a", prNumber: 5 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={() => <div>review view</div>}
        {...props}
      />
    )

    it("switches to the requested tab and reports it handled", () => {
      const onTabRequestHandled = vi.fn()
      render(
        pane({ selectTabRequest: { tabId: "pr", nonce: 1 }, onTabRequestHandled })
      )
      expect(screen.getByText("review view")).toBeTruthy()
      expect(onTabRequestHandled).toHaveBeenCalledTimes(1)
    })

    /**
     * The regression.
     *
     * A pane is keyed by `pane.sessionId` (`split-view.tsx`), so switching
     * sessions REMOUNTS it — and a mount runs the request effect with whatever
     * is still in the prop. One "Go to Code Review" used to mean every session
     * you opened afterwards landed on Code Review, which reads as the palette
     * having changed a setting rather than performed an action.
     *
     * Reported-handled is what prevents it: the owner drops the request, so the
     * next mount sees null. This test asserts the pane's half — that a mount
     * with NO live request does not resurrect one.
     */
    it("does not replay a request into another session", () => {
      const onTabRequestHandled = vi.fn()
      const { unmount } = render(
        pane({ selectTabRequest: { tabId: "pr", nonce: 1 }, onTabRequestHandled })
      )
      expect(screen.getByText("review view")).toBeTruthy()
      expect(onTabRequestHandled).toHaveBeenCalledTimes(1)

      unmount()
      render(
        <SessionPane
          session={session({ id: "b", prNumber: 6 })}
          renderConversation={(s) => <div>transcript {s.id}</div>}
          renderPullRequest={() => <div>review view</div>}
          selectTabRequest={null}
          onTabRequestHandled={onTabRequestHandled}
        />
      )

      expect(screen.queryByText("review view")).toBeNull()
      expect(screen.getByText("transcript b")).toBeTruthy()
    })

    it("fires again for the same tab when the nonce moves", () => {
      const onTabRequestHandled = vi.fn()
      const { rerender } = render(
        pane({ selectTabRequest: { tabId: "pr", nonce: 1 }, onTabRequestHandled })
      )
      rerender(pane({ selectTabRequest: null, onTabRequestHandled }))
      expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull()
      fireEvent.click(screen.getByRole("tab", { name: /Chat 1/ }))
      expect(screen.getByText("transcript a")).toBeTruthy()

      // Asking for the SAME tab a second time has to work — that is what the
      // nonce is for, over and above the clearing.
      rerender(pane({ selectTabRequest: { tabId: "pr", nonce: 2 }, onTabRequestHandled }))
      expect(screen.getByText("review view")).toBeTruthy()
      expect(onTabRequestHandled).toHaveBeenCalledTimes(2)
    })

    it("does nothing at all when no request was ever made", () => {
      const onTabRequestHandled = vi.fn()
      render(pane({ onTabRequestHandled }))
      expect(screen.getByText("transcript a")).toBeTruthy()
      expect(onTabRequestHandled).not.toHaveBeenCalled()
    })
  })

  it("falls back to Conversation when the selected tab stops being available", async () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a", prNumber: 5 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={() => <div>review view</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(screen.getByText("review view")).toBeTruthy()

    // The PR goes away (merged and unlinked, no worktree) — the tab is no longer visible,
    // so the pane must not be left showing a tab that isn't in the bar.
    rerender(
      <SessionPane
        session={session({ id: "a", prNumber: null, worktreePath: undefined })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={() => <div>review view</div>}
      />
    )
    await waitFor(() => expect(screen.queryByText("review view")).toBeNull())
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("gives each session its own layout when the SAME pane swaps sessions", () => {
    const pane = (id: string, prNumber: number) => (
      <SessionPane
        session={session({ id, prNumber })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={(s) => <div>pr view {s.id}</div>}
      />
    )
    const { rerender } = render(pane("a", 1))
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(screen.getByText("pr view a")).toBeTruthy()

    rerender(pane("b", 2))
    expect(screen.queryByTestId("editor-tab-view-pr")).toBeNull()
    rerender(pane("a", 1))
    expect(screen.getByText("pr view a")).toBeTruthy()
  })

  it("routes a plan deep-link to its own view tab", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["c_a_1"])}
        renderConversation={(s, view, ctx) => (
          <div>
            <button onClick={() => ctx.onOpenPlanReview("s_02")}>jump</button>
            <span>
              {view}:{s.id}:{ctx.planStepId ?? "none"}
            </span>
          </div>
        )}
      />
    )
    fireEvent.click(screen.getByText("jump"))
    expect(screen.getByText("plan:a:s_02")).toBeTruthy()
  })
})
