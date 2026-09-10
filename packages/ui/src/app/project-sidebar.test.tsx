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
  it("shows every project, selected first then sessions by recency, with counts", () => {
    render(
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
})
