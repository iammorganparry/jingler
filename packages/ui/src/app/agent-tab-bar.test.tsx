import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AgentTabBar,
  MAIN_AGENT,
  type AgentTabItem,
  type VisibleAgentStatus
} from "./agent-tab-bar.js"

afterEach(cleanup)

const item = (
  id: string,
  status: VisibleAgentStatus,
  action?: AgentTabItem["action"]
): AgentTabItem => ({
  id,
  name: id,
  description: `${id} description`,
  status,
  hasChildren: false,
  ...(action === undefined ? {} : { action })
})

const callbacks = () => ({
  onChange: vi.fn(),
  onDrill: vi.fn(),
  onNavigate: vi.fn(),
  onStop: vi.fn(),
  onClose: vi.fn()
})

describe("AgentTabBar worker lifecycles", () => {
  it("renders each worker status with the established theme-token treatment", () => {
    const { container } = render(
      <AgentTabBar
        agents={[
          item("queued-agent", "queued"),
          item("running-agent", "running", "stop"),
          item("blocked-agent", "blocked"),
          item("failed-agent", "failed"),
          item("interrupted-agent", "interrupted"),
          item("completed-agent", "completed")
        ]}
        trail={[]}
        active={MAIN_AGENT}
        {...callbacks()}
      />
    )

    const tone = (status: VisibleAgentStatus): string =>
      container
        .querySelector(`[data-agent-status="${status}"] .inline-block`)
        ?.getAttribute("class") ?? ""

    expect(tone("queued")).toContain("bg-dim")
    expect(tone("running")).toContain("bg-yellow")
    expect(tone("running")).toContain("animate-pulse-dot")
    expect(tone("blocked")).toContain("bg-yellow")
    expect(tone("blocked")).not.toContain("animate-pulse-dot")
    expect(tone("failed")).toContain("bg-red")
    expect(tone("interrupted")).toContain("bg-dim")
    expect(tone("completed")).toContain("bg-green")
  })

  it("stops only running workers and gives replay-backed settled workers no close action", () => {
    const handlers = callbacks()
    render(
      <AgentTabBar
        agents={[
          item("worker-auth", "running", "stop"),
          item("worker-release", "completed")
        ]}
        trail={[]}
        active="worker-auth"
        {...handlers}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Stop worker-auth" }))
    expect(handlers.onStop).toHaveBeenCalledWith("worker-auth")
    expect(handlers.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Close worker-release" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop worker-release" })).toBeNull()
  })
})

describe("AgentTabBar legacy agents", () => {
  it("preserves Main navigation, drill-in, settled close, and reviewer controls", () => {
    const handlers = callbacks()
    render(
      <AgentTabBar
        agents={[
          {
            ...item("Explore", "working", "stop"),
            hasChildren: true
          },
          item("Settled", "done", "close"),
          item("Reviewer", "done")
        ]}
        trail={[{ id: "parent", name: "Parent" }]}
        active="Explore"
        {...handlers}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Main" }))
    expect(handlers.onNavigate).toHaveBeenCalledWith(MAIN_AGENT)

    fireEvent.click(
      screen.getByRole("button", { name: "Show Explore's sub-agents" })
    )
    expect(handlers.onDrill).toHaveBeenCalledWith("Explore")

    fireEvent.click(screen.getByRole("button", { name: "Close Settled" }))
    expect(handlers.onClose).toHaveBeenCalledWith("Settled")

    expect(screen.queryByRole("button", { name: "Close Reviewer" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop Reviewer" })).toBeNull()
  })
})
