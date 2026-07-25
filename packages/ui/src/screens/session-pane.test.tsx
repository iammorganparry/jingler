import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Boxes } from "lucide-react"
import type { Session } from "@starbase/core"
import { SessionPane } from "./session-pane.js"
import {
  builtinTabContributions,
  PLUGIN_TAB_ORDER,
  type TabContribution,
  visibleTabs
} from "../app/tab-contributions.js"
import { testSession as session } from "../test-support.js"

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

  it("adds Issue when an issue is linked", () => {
    expect(idsFor(session({ id: "a", issueNumber: 7 }))).toContain("issue")
  })

  it("adds Plan only for sessions with a plan", () => {
    const s = session({ id: "a" })
    expect(idsFor(s, { hasPlan: true })).toContain("plan")
    expect(idsFor(s, { hasPlan: false })).not.toContain("plan")
  })

  it("swaps Changes for Review once a PR exists", () => {
    expect(idsFor(session({ id: "a" }))).toContain("changes")
    expect(idsFor(session({ id: "a", prNumber: 12 }))).toContain("review")
    expect(idsFor(session({ id: "a", prNumber: 12 }))).not.toContain("changes")
  })

  it("keeps the built-in order the operator already knows", () => {
    expect(idsFor(session({ id: "a", issueNumber: 7 }), { hasPlan: true })).toEqual([
      "conversation",
      "issue",
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

describe("plugin tab contributions", () => {
  it("renders a plugin tab body through the same path as a built-in", () => {
    render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        tabContributions={[pluginTab("linear.issues")]}
      />
    )
    fireEvent.click(screen.getByText("linear.issues"))
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
    expect(screen.getByText("linear.issues")).toBeTruthy()
  })

  it("falls back off a plugin tab when its plugin is disabled mid-session", () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a" })}
        renderConversation={() => <div>transcript</div>}
        tabContributions={[pluginTab("linear.issues")]}
      />
    )
    fireEvent.click(screen.getByText("linear.issues"))
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

describe("mount groups", () => {
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

    fireEvent.click(screen.getByText("Plan Review"))
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
    fireEvent.click(screen.getByText("Pull Request"))
    expect(onMount).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("Code Review"))
    fireEvent.click(screen.getByText("Pull Request"))
    expect(onMount).toHaveBeenCalledTimes(2)
  })
})

describe("SessionPane", () => {
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
    fireEvent.click(within(paneA).getByText("Pull Request"))

    expect(within(paneA).getByText("pr view a")).toBeTruthy()
    expect(within(screen.getByTestId("pane-b")).getByText("transcript b")).toBeTruthy()
  })

  it("falls back to Conversation when the selected tab stops being available", () => {
    const { rerender } = render(
      <SessionPane
        session={session({ id: "a", prNumber: 5 })}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderReview={() => <div>review view</div>}
      />
    )
    fireEvent.click(screen.getByText("Code Review"))
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
    fireEvent.click(screen.getByText("Pull Request"))
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

  it("routes a plan deep-link to the Plan view for its own session", () => {
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
    expect(screen.getByText("plan:a:s_02")).toBeTruthy()
  })
})
