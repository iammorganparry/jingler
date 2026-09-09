import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { NewWorkspaceView } from "./new-workspace-view.js"

const projects: ReadonlyArray<Project> = [
  { id: "alpha", name: "Alpha", path: "/repos/alpha", availability: "available", createdAt: "now", updatedAt: "now" },
  { id: "beta", name: "Beta", path: "/repos/beta", availability: "available", createdAt: "now", updatedAt: "now" }
]

const view = (defaultProjectId: string) => (
  <NewWorkspaceView
    open
    projects={projects}
    defaultProjectId={defaultProjectId}
    prepareProject={async (id) => projects.find((project) => project.id === id)!}
    loadBranches={async () => ["main"]}
    onCreate={vi.fn(async () => undefined)}
    onClose={() => {}}
  />
)

afterEach(cleanup)

it("follows a project-rail selection while the form is open", async () => {
  const rendered = render(view("alpha"))
  const picker = await screen.findByRole("button", { name: "Project" })
  await waitFor(() => expect(picker.textContent).toContain("Alpha"))

  rendered.rerender(view("beta"))
  await waitFor(() => expect(picker.textContent).toContain("Beta"))
})
