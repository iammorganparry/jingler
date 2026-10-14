import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { testSession } from "../test-support.js"
import { ProjectSidebar } from "./project-sidebar.js"

const projects: ReadonlyArray<Project> = [
  { id: "alpha", name: "Alpha", path: "/repos/alpha", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "beta", name: "Beta", path: "/repos/beta", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "gamma", name: "Gamma", path: "/repos/gamma", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "empty", name: "Empty", path: "/repos/empty", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
]

const sessions = [
  testSession({ id: "alpha-old", projectId: "alpha", updatedAt: "2026-07-01T00:00:00.000Z" }),
  testSession({ id: "alpha-new", projectId: "alpha", updatedAt: "2026-07-02T00:00:00.000Z" }),
  testSession({ id: "beta-newest", projectId: "beta", updatedAt: "2026-07-03T00:00:00.000Z" }),
  testSession({ id: "gamma-middle", projectId: "gamma", updatedAt: "2026-07-02T12:00:00.000Z" }),
  testSession({ id: "empty-archived", projectId: "empty", archived: true })
]

afterEach(cleanup)

describe("ProjectSidebar", () => {
  it("sorts by open-session count, preserving ties regardless of selection and recency", () => {
    const { rerender } = render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="alpha"
        projectOwners={{ alpha: "acme" }}
        onSelect={() => {}}
      />
    )

    const buttons = screen.getAllByRole("button")
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Empty"
    ])
    expect(within(screen.getByRole("button", { name: "Alpha" })).getByText("2")).toBeTruthy()
    expect(within(screen.getByRole("button", { name: "Beta" })).getByText("1")).toBeTruthy()
    expect(within(screen.getByRole("button", { name: "Empty" })).getByText("0")).toBeTruthy()
    const avatar = screen.getByAltText("A")
    expect(avatar.getAttribute("src")).toContain("github.com/acme.png")
    const updatedSessions = [
      ...sessions.toReversed(),
      testSession({ id: "gamma-two", projectId: "gamma" }),
      testSession({ id: "gamma-three", projectId: "gamma" })
    ]
    for (const activeProjectId of ["gamma", "empty"]) {
      rerender(<ProjectSidebar projects={projects} sessions={updatedSessions} activeProjectId={activeProjectId} onSelect={() => {}} />)
      expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
        "Gamma", "Alpha", "Beta", "Empty"
      ])
    }
  })

  it("shows live work on unselected projects, excluding archived and waiting sessions", () => {
    const props = {
      projects,
      sessions: [
        testSession({ id: "working", projectId: "beta", status: "idle" }),
        testSession({ id: "waiting", projectId: "alpha", status: "needs-input" }),
        testSession({ id: "archived", projectId: "empty", status: "running", archived: true })
      ],
      activeProjectId: "alpha",
      onSelect: vi.fn()
    }
    const { rerender } = render(<ProjectSidebar {...props} liveActivity={{
      working: { kind: "thinking", verb: "Thinking", target: null, startedAt: 0 }
    }} />)
    expect(screen.getByRole("status", { name: "Beta: sessions in progress" })).toBeTruthy()
    expect(screen.getAllByRole("status")).toHaveLength(1)
    rerender(<ProjectSidebar {...props} />)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("shows project details when its avatar receives focus", async () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[testSession({ id: "session", projectId: "alpha", status: "running" })]}
        activeProjectId="alpha"
        onSelect={() => {}}
      />
    )
    fireEvent.focus(screen.getByRole("button", { name: "Alpha" }))
    expect((await screen.findAllByText("1 open session")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("1 active").length).toBeGreaterThan(0)
    expect(screen.getAllByText("/repos/alpha").length).toBeGreaterThan(0)
  })

  it("selects a project by durable id", () => {
    const onSelect = vi.fn()
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="alpha"
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Beta" }))
    expect(onSelect).toHaveBeenCalledWith("beta")
  })

  it("shows project placeholders while projects load", () => {
    render(
      <ProjectSidebar
        projects={[]}
        sessions={sessions}
        activeProjectId="alpha"
        loading
        onSelect={() => {}}
      />
    )
    expect(screen.getByTestId("project-sidebar").getAttribute("aria-busy")).toBe("true")
    expect(screen.getAllByTestId("project-skeleton")).toHaveLength(3)
  })

  it("renders a 56px rail on neutral tokens with a white bar and fill on the active tile", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[testSession({ id: "w", projectId: "beta", status: "running" })]}
        activeProjectId="alpha"
        liveActivity={{ w: { kind: "thinking", verb: "Thinking", target: null, startedAt: 0 } }}
        onSelect={() => {}}
      />
    )
    const rail = screen.getByTestId("project-sidebar")
    expect(rail.className).toContain("w-14")
    expect(rail.className).toContain("bg-canvas")
    const active = screen.getByRole("button", { name: "Alpha" })
    expect(active.className).toContain("bg-surface")
    expect(active.querySelector(".bg-text-bright")).toBeTruthy()
    const inactive = screen.getByRole("button", { name: "Beta" })
    expect(inactive.querySelector(".bg-text-bright")).toBeNull()
    expect(screen.getByRole("status", { name: "Beta: sessions in progress" }).innerHTML).toContain("bg-state-working")
    for (const button of screen.getAllByRole("button")) {
      expect(button.innerHTML).not.toMatch(/bg-(blue|green|yellow|red|brand)\b|text-brand/)
    }
  })

  it("opens a tile context menu with Settings and a destructive, confirmed Remove", async () => {
    const onOpenSettings = vi.fn()
    const onRemove = vi.fn()
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="alpha"
        onSelect={() => {}}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
      />
    )
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }))
    expect(onOpenSettings).toHaveBeenCalledWith("beta")

    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove project" }))
    // Nothing is removed until the confirm dialog is accepted.
    expect(onRemove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }))
    expect(onRemove).toHaveBeenCalledWith("beta")
  })

  it("has no tile menu without handlers", () => {
    render(<ProjectSidebar projects={projects} sessions={sessions} activeProjectId="alpha" onSelect={() => {}} />)
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }))
    expect(screen.queryByRole("menuitem")).toBeNull()
  })
})
