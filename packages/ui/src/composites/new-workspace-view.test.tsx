import { settingsModels } from "./project-settings-fixtures.js"
import { act, fireEvent, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { NewWorkspaceView } from "./new-workspace-view.js"

vi.mock("../lib/image-downscale.js", () => ({ downscaleImage: vi.fn(async () => ({ name: "draft.png", mediaType: "image/png", data: "aW1hZ2U=" })) }))

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
  await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Alpha"))

  rendered.rerender(view("beta"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Beta"))
})

it("shows send-button submission, ignores duplicate mouse/Enter and retains the draft after deferred creation fails", async () => {
  let reject!: (error: Error) => void
  let resolve!: () => void
  const onCreate = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail }))
  const onClose = vi.fn()
  const model = settingsModels[0]!
  render(<NewWorkspaceView open projects={projects} defaultProjectId="alpha"
    providerCatalog={{ refreshedAt: "now", stale: false, connections: [{ connection: model.connection, models: settingsModels }] }}
    defaultConnectionId={model.connection.id} defaultModelId={model.id}
    prepareProject={async () => projects[0]!} loadBranches={async () => ["main"]}
    onCreate={onCreate} onClose={onClose} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Send ↵" })).toBeDefined())
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "Keep this creation draft" } })
  fireEvent.paste(input, { clipboardData: { files: [new File(["image"], "draft.png", { type: "image/png" })] } })
  await waitFor(() => expect(screen.getByRole("img", { name: "draft.png" })).toBeDefined())
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }))
  await screen.findByTestId("workspace-provisioning")
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined()
  // The composer is replaced while provisioning, so a second submit is impossible.
  expect(screen.queryByRole("button", { name: "Send ↵" })).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(onCreate).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error("Creation failed")))
  await screen.findByText("Creation failed")
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  const kept = await screen.findByRole("textbox")
  expect(kept).toHaveProperty("value", "Keep this creation draft")
  expect(screen.getByRole("img", { name: "draft.png" })).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }))
  expect(onCreate).toHaveBeenCalledTimes(2)
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
  await screen.findByRole("textbox")
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }))
  expect(onCreate).toHaveBeenCalledTimes(3)
  await act(async () => resolve())
  expect(onClose).toHaveBeenCalledOnce()
  expect(screen.queryByTestId("workspace-provisioning")).toBeNull()
})

it("renders one chip row: project, from <branch>, checkout with explainers, and composer-first heading", async () => {
  render(view("alpha"))
  const row = await screen.findByTestId("new-workspace-chip-row")
  await waitFor(() => expect(row.textContent).toContain("from main"))
  expect(screen.getByRole("heading", { name: "New workspace" })).toBeDefined()
  expect(screen.queryByRole("button", { name: "Session source" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Base branch" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Start from" }))
  for (const name of ["Branch", "Pull request"]) if (name === "Branch") expect(await screen.findByRole("tab", { name })).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Checkout" }))
  expect(await screen.findByText("Work directly in the project checkout")).toBeDefined()
  expect(screen.getByText("Isolated Git worktree for this session")).toBeDefined()
})
