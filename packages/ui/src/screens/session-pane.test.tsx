import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Boxes } from "lucide-react"
import type { Session } from "@jingler/core"
import { SessionPane } from "./session-pane.js"
import {
  builtinTabContributions,
  PLUGIN_TAB_ORDER,
  type TabContribution,
  visibleTabs
} from "../app/tab-contributions.js"
import { testSession as session } from "../test-support.js"

beforeEach(() => localStorage.clear())
afterEach(cleanup)

/** The built-ins with inert bodies — these tests are about which tabs, not what's in them. */
const BUILTINS = builtinTabContributions({
  conversation: () => null,
  stub: () => null
})

const idsFor = (
  s: Session,
  opts: { hasPlan?: boolean; extra?: ReadonlyArray<TabContribution> } = {}
) =>
  visibleTabs(
    { session: s, hasPlan: opts.hasPlan ?? false },
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

  it("shows Plan for any worktree-backed session, even before a plan exists", () => {
    // The tab is now always present for a worktree session so the operator can
    // author a plan for the agent; it needs a worktree to hold current-plan.mdx.
    const s = session({ id: "a" })
    expect(idsFor(s, { hasPlan: false })).toContain("plan")
    expect(idsFor(s, { hasPlan: true })).toContain("plan")
    expect(idsFor(session({ id: "b", worktreePath: undefined }))).not.toContain("plan")
  })

  it("shows Files only for worktree-backed sessions", () => {
    expect(idsFor(session({ id: "a" }))).toContain("files")
    expect(idsFor(session({ id: "b", worktreePath: undefined }))).not.toContain("files")
  })

  it("swaps Changes for Review once a PR exists", () => {
    expect(idsFor(session({ id: "a" }))).toContain("changes")
    expect(idsFor(session({ id: "a", prNumber: 12 }))).toContain("review")
    expect(idsFor(session({ id: "a", prNumber: 12 }))).not.toContain("changes")
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
  it("opens inside its owning session pane and closes back to conversation", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }))
    expect(screen.getByText("owner transcript")).toBeTruthy()
    expect(toggled).toEqual(["browser-owner", "browser-owner"])
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
  it("opens Plan Review beside chat when the pane is roomy", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
        renderConversation={(_session, view) => (
          <span data-testid="plan-presentation">{view}</span>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Plan Review" }))
    expect(screen.getByTestId("plan-presentation").textContent).toBe("split")
  })

  it("opens the first streamed draft beside a roomy conversation", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
        renderConversation={(_session, view, ctx) => (
          <div>
            <button onClick={ctx.onPlanDraftAvailable}>stream draft</button>
            <span data-testid="plan-presentation">{view}</span>
          </div>
        )}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "stream draft" }))
    expect(screen.getByTestId("plan-presentation").textContent).toBe("split")
  })

  it("opens streamed Plan Review full-width when the pane is too narrow", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 600,
        bottom: 800,
        left: 0,
        width: 600,
        height: 800,
        toJSON: () => ({})
      })
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
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
    expect(screen.getByTestId("plan-presentation").textContent).toBe("plan")
    rect.mockRestore()
  })

  it("opens a manually selected Plan Review full-width when the pane is too narrow", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 600,
        bottom: 800,
        left: 0,
        width: 600,
        height: 800,
        toJSON: () => ({})
      })
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
        renderConversation={(_session, view) => (
          <span data-testid="plan-presentation">{view}</span>
        )}
      />
    )

    await screen.findByRole("button", { name: "Plan Review" })
    fireEvent.click(screen.getByRole("button", { name: "Plan Review" }))
    expect(screen.getByTestId("plan-presentation").textContent).toBe("plan")
    rect.mockRestore()
  })

  it("keeps ONE conversation mount across the Conversation/Plan switch", () => {
    // The rule the old hardcoded `activeTab === "conversation" || "plan"` branch
    // encoded: switching to Plan Review must not unmount — and so abort — a
    // parked plan run.
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
        planSessions={new Set(["a"])}
        renderConversation={() => <Body />}
      />
    )
    expect(onMount).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Plan Review" }))
    expect(onMount).toHaveBeenCalledTimes(1)
  })

  it("remounts a tab outside that group, which the virtualized transcript requires", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Code Review" }))
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(onMount).toHaveBeenCalledTimes(2)
  })
})

describe("SessionPane", () => {
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

  it("opens Files beside chat with the default two-thirds workspace", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 1_200,
        bottom: 800,
        left: 0,
        width: 1_200,
        height: 800,
        toJSON: () => ({})
      })
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
        renderFiles={(s) => <div>files for {s.id}</div>}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Files" }))

    expect(screen.getByTestId("session-auxiliary-chat").textContent).toContain(
      "transcript for a"
    )
    expect(screen.getByTestId("session-auxiliary-panel").textContent).toContain(
      "files for a"
    )
    await waitFor(() => {
      expect(screen.getByTestId("session-auxiliary-panel").getAttribute("style")).toContain(
        "66.6667%"
      )
    })
    rect.mockRestore()
  })

  it("opens every auxiliary view beside chat when the pane is wide", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
        renderFiles={(s) => <div>files for {s.id}</div>}
        renderPullRequest={(s) => <div>pull request for {s.id}</div>}
        renderCode={(s) => <div>changes for {s.id}</div>}
        tabContributions={[pluginTab("linear.issues")]}
      />
    )

    for (const [tabName, body] of [
      ["Files", "files for a"],
      ["Pull Request", "pull request for a"],
      ["Changes", "changes for a"],
      ["linear.issues", "linear.issues body"]
    ]) {
      fireEvent.click(screen.getByRole("button", { name: tabName }))
      expect(screen.getByTestId("session-auxiliary-split")).toBeTruthy()
      expect(screen.getByTestId("session-auxiliary-chat").textContent).toContain(
        "transcript for a"
      )
      expect(screen.getByTestId("session-auxiliary-panel").textContent).toContain(body)
      expect(
        screen.getByRole("separator", { name: `Resize ${tabName}` })
      ).toBeTruthy()
    }
  })

  it("persists a resized Files workspace ratio", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 1_200,
        bottom: 800,
        left: 0,
        width: 1_200,
        height: 800,
        toJSON: () => ({})
      })
    const first = render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        renderFiles={() => <div>files</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    const divider = screen.getByRole("separator", { name: "Resize Files" })
    // jsdom does not expose PointerEvent, so Testing Library's pointer helper
    // drops clientX. MouseEvent still carries the pointer coordinates through
    // React's pointer listener and the window-level native listeners.
    fireEvent(divider, new MouseEvent("pointerdown", { bubbles: true, clientX: 800 }))
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 680 }))
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }))

    const persisted = Number(localStorage.getItem("sb.split.session-auxiliary.ratio"))
    expect(persisted).toBeGreaterThan(2 / 3)
    first.unmount()

    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        renderFiles={() => <div>files</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Files" }))
    await waitFor(() => {
      const style = screen.getByTestId("session-auxiliary-panel").getAttribute("style") ?? ""
      const renderedPercent = Number(style.slice(style.indexOf("calc(") + 5, style.indexOf("%")))
      expect(renderedPercent).toBeCloseTo(persisted * 100, 3)
    })
    rect.mockRestore()
  })

  it("gives Files the full pane below the responsive breakpoint", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 600,
        bottom: 800,
        left: 0,
        width: 600,
        height: 800,
        toJSON: () => ({})
      })
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript for {s.id}</div>}
        renderFiles={(s) => <div>files for {s.id}</div>}
      />
    )

    await screen.findByRole("button", { name: "Files" })
    fireEvent.click(screen.getByRole("button", { name: "Files" }))

    expect(screen.queryByTestId("session-auxiliary-split")).toBeNull()
    expect(screen.getByText("files for a")).toBeTruthy()
    expect(screen.queryByText("transcript for a")).toBeNull()
    rect.mockRestore()
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

  it("routes a transcript file gesture into this session's Files tab", () => {
    const onOpenFile = vi.fn()
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(_s, _view, ctx) => (
          <button type="button" onClick={() => ctx.onOpenFile("src/main.ts")}>
            open source
          </button>
        )}
        renderFiles={(s) => <div>files for {s.id}</div>}
        onOpenFile={onOpenFile}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "open source" }))

    expect(onOpenFile).toHaveBeenCalledWith("a", "src/main.ts")
    expect(screen.getByText("files for a")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-current")).toBe(
      "page"
    )
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
        renderChatTabs={(_session, ctx) => (
          <button type="button" onClick={ctx.onSelectConversation}>
            Active chat
          </button>
        )}
        renderReview={() => <div>review view</div>}
        {...props}
      />
    )

    it("switches to the requested tab and reports it handled", () => {
      const onTabRequestHandled = vi.fn()
      render(
        pane({ selectTabRequest: { tabId: "review", nonce: 1 }, onTabRequestHandled })
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
    it("does not replay a request the owner has already cleared", () => {
      const onTabRequestHandled = vi.fn()
      const { unmount } = render(
        pane({ selectTabRequest: { tabId: "review", nonce: 1 }, onTabRequestHandled })
      )
      expect(screen.getByText("review view")).toBeTruthy()
      expect(onTabRequestHandled).toHaveBeenCalledTimes(1)

      // What the owner does on being told: drop it. The pane then remounts, as
      // it does on every session switch.
      unmount()
      render(pane({ selectTabRequest: null, onTabRequestHandled }))

      expect(screen.queryByText("review view")).toBeNull()
      expect(screen.getByText("transcript a")).toBeTruthy()
    })

    it("fires again for the same tab when the nonce moves", () => {
      const onTabRequestHandled = vi.fn()
      const { rerender } = render(
        pane({ selectTabRequest: { tabId: "review", nonce: 1 }, onTabRequestHandled })
      )
      rerender(pane({ selectTabRequest: null, onTabRequestHandled }))
      expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Active chat" }))
      expect(screen.getByText("transcript a")).toBeTruthy()

      // Asking for the SAME tab a second time has to work — that is what the
      // nonce is for, over and above the clearing.
      rerender(pane({ selectTabRequest: { tabId: "review", nonce: 2 }, onTabRequestHandled }))
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

  it("falls back to Conversation when the selected tab stops being available", () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a", prNumber: 5 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderReview={() => <div>review view</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Code Review" }))
    expect(screen.getByText("review view")).toBeTruthy()

    // The PR goes away (merged and unlinked) — Review is no longer a visible tab,
    // so the pane must not be left showing a tab that isn't in the bar.
    rerender(
      <SessionPane
        session={session({ id: "a", prNumber: null })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderReview={() => <div>review view</div>}
      />
    )
    expect(screen.queryByText("review view")).toBeNull()
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("keeps the selected tab when the SAME pane swaps to another session", () => {
    // Pre-grid, `tab` lived in SessionConversation which was not keyed by
    // session, so switching sessions kept your tab. The grid must not regress
    // that: SessionPane is deliberately left unkeyed inside its slot.
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a", prNumber: 1 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={(s) => <div>pr view {s.id}</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Pull Request" }))
    expect(screen.getByText("pr view a")).toBeTruthy()

    rerender(
      <SessionPane
        session={session({ id: "b", prNumber: 2 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderPullRequest={(s) => <div>pr view {s.id}</div>}
      />
    )
    expect(screen.getByText("pr view b")).toBeTruthy()
  })

  it("routes a plan deep-link to the responsive split for its own session", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        planSessions={new Set(["a"])}
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
    expect(screen.getByText("split:a:s_02")).toBeTruthy()
  })
})
