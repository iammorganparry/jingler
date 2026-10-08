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
  const picker = await screen.findByRole("button", { name: "Project" })
  await waitFor(() => expect(picker.textContent).toContain("Alpha"))

  rendered.rerender(view("beta"))
  await waitFor(() => expect(picker.textContent).toContain("Beta"))
})

it("describes the concise checkpoint-safe checkbox on keyboard focus without changing its default", async () => {
  render(view("alpha"))
  const checkbox = await screen.findByRole("checkbox", { name: "Checkpoint-safe mode" })
  expect(checkbox).toHaveProperty("checked", false)
  expect(checkbox.closest("label")?.textContent?.trim()).toBe("Checkpoint-safe mode")
  await waitFor(() => expect(checkbox).toHaveProperty("disabled", false))
  checkbox.focus()
  const tooltip = await screen.findByRole("tooltip", { hidden: true })
  expect(checkbox.getAttribute("aria-describedby")).toBe(tooltip.id)
  expect(tooltip.textContent).toBe("Enable checkpoint-safe mode before the first turn. Local isolated managed Pi only; structured edits and read-only inspection. File rename is unsupported in safe mode; no files are changed. Shell/build/test, setup commands, terminals, delegation and offload are blocked.")
  checkbox.click()
  expect(checkbox).toHaveProperty("checked", true)
})
it("accepts checkpoint-safe selection only after branch loading finishes", async () => {
  let resolve!: (branches: ReadonlyArray<string>) => void
  render(<NewWorkspaceView open projects={projects} defaultProjectId="alpha"
    prepareProject={async () => projects[0]!}
    loadBranches={() => new Promise((done) => { resolve = done })}
    onCreate={vi.fn(async () => undefined)} onClose={() => {}} />)
  const checkbox = screen.getByRole("checkbox", { name: "Checkpoint-safe mode" })
  expect(checkbox).toHaveProperty("disabled", true)
  checkbox.click()
  expect(checkbox).toHaveProperty("checked", false)
  await waitFor(() => expect(resolve).toBeDefined())
  await act(async () => resolve(["main"]))
  expect(checkbox).toHaveProperty("disabled", false)
  checkbox.click()
  expect(checkbox).toHaveProperty("checked", true)
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
  const button = await screen.findByRole("button", { name: "Creating session" })
  expect(button).toHaveProperty("disabled", true)
  expect(button.getAttribute("aria-busy")).toBe("true")
  expect(screen.getByRole("checkbox", { name: "Checkpoint-safe mode" })).toHaveProperty("disabled", true)
  expect(button.querySelector("svg.lucide-loader-circle")).not.toBeNull()
  expect(screen.queryByText("Creating session…")).toBeNull()
  fireEvent.click(button)
  fireEvent.keyDown(input, { key: "Enter" })
  expect(onCreate).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error("Creation failed")))
  await screen.findByText("Creation failed")
  expect(input).toHaveProperty("value", "Keep this creation draft")
  expect(screen.getByRole("img", { name: "draft.png" })).toBeDefined()
  const send = screen.getByRole("button", { name: "Send ↵" })
  expect(send).toHaveProperty("disabled", false)
  expect(send.getAttribute("aria-busy")).toBeNull()
  fireEvent.click(send)
  expect(onCreate).toHaveBeenCalledTimes(2)
  await act(async () => resolve())
  expect(onClose).toHaveBeenCalledOnce()
  expect(screen.queryByRole("button", { name: "Creating session" })).toBeNull()
})
