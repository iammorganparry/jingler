import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { NewWorkspaceView } from "./new-workspace-view.js"

const projects: ReadonlyArray<Project> = [
  { id: "alpha", name: "Alpha", path: "/repos/alpha", availability: "available", createdAt: "now", updatedAt: "now" },
  { id: "beta", name: "Beta", path: "/repos/beta", availability: "available", createdAt: "now", updatedAt: "now" }
]

const view = (defaultProjectId: string, availableProjects = projects, requestedProjectId?: string) => (
  <NewWorkspaceView
    open
    projects={availableProjects}
    defaultProjectId={defaultProjectId}
    requestedProjectId={requestedProjectId}
    prepareProject={async (id) => projects.find((project) => project.id === id)!}
    loadBranches={async () => ["main"]}
    onCreate={vi.fn(async () => undefined)}
    onClose={() => {}}
  />
)

afterEach(cleanup)

it("does not replace a non-first default project during initial opening", async () => {
  render(view("beta"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Beta"))
})

it("uses the requested project when the project list arrives after opening", async () => {
  const rendered = render(view("beta", []))
  rendered.rerender(view("beta"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Beta"))
})

it("keeps an explicit project request ahead of the current default", async () => {
  render(view("alpha", projects, "beta"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Beta"))
})

it("follows a project-rail selection while the form is open", async () => {
  const rendered = render(view("alpha"))
  const picker = await screen.findByRole("button", { name: "Project" })
  await waitFor(() => expect(picker.textContent).toContain("Alpha"))

  rendered.rerender(view("beta"))
  await waitFor(() => expect(picker.textContent).toContain("Beta"))
})
