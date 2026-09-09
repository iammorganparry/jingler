import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { testSession } from "../test-support.js"
import { ProjectSidebar } from "./project-sidebar.js"

const projects: ReadonlyArray<Project> = [
  { id: "alpha", name: "Alpha", path: "/repos/alpha", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "empty", name: "Empty", path: "/repos/empty", availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01" }
]

afterEach(cleanup)

describe("ProjectSidebar", () => {
  it("keeps registered projects visible even without sessions", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[testSession({ id: "session", projectId: "alpha" })]}
        activeProjectId="alpha"
        projectOwners={{ alpha: "acme" }}
        onSelect={() => {}}
      />
    )
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Empty" })).toBeTruthy()
    const avatar = screen.getByAltText("A")
    expect(avatar.getAttribute("src")).toContain("github.com/acme.png")
    expect(avatar.className).toContain("rounded-[10px]")
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
      <ProjectSidebar projects={projects} sessions={[]} activeProjectId="alpha" onSelect={onSelect} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Empty" }))
    expect(onSelect).toHaveBeenCalledWith("empty")
  })
})
