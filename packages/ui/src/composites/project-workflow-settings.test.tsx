import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { ProjectWorkflowSettings } from "./project-workflow-settings.js"

const project: Project = {
  id: "p-1",
  imported: true,
  name: "widget",
  path: "/repos/widget",
  availability: "available",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}

afterEach(cleanup)

describe("ProjectWorkflowSettings", () => {
  it("invalidates visible approval after content changes and submits exact commands", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "pnpm install" } })
    fireEvent.change(screen.getByLabelText("Run commands"), { target: { value: "Dev=pnpm dev" } })
    fireEvent.change(screen.getByLabelText("Copied files"), { target: { value: ".env.local" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      projectId: "p-1",
      setup: "pnpm install",
      runs: [{ id: expect.stringMatching(/^run-/), label: "Dev", command: "pnpm dev" }],
      copyFiles: [".env.local"],
      ports: { primary: 3100, extras: [], previewUrl: "http://localhost:{port}" },
      approve: true
    }))
    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "pnpm install --frozen-lockfile" } })
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
  })
  it("keeps partial port text editable and parses only when saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    const input = screen.getByLabelText("Additional service ports") as HTMLTextAreaElement
    for (const character of "API=46000") {
      fireEvent.change(input, { target: { value: input.value + character } })
      expect(input.value).not.toContain("NaN")
    }
    expect(input.value).toBe("API=46000")
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ ports: expect.objectContaining({ extras: [{ name: "API", start: 46000 }] }) })))
    onSave.mockClear()
    fireEvent.change(input, { target: { value: "API=" } })
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await screen.findByText(/Additional ports must use/)
    expect(onSave).not.toHaveBeenCalled()
    expect(input.value).toBe("API=")
  })

  it("rejects malformed nonempty lines without saving partial commands", async () => {
    const onSave = vi.fn()
    render(<ProjectWorkflowSettings projects={[project]} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Run commands"), { target: { value: "Dev=pnpm dev\nBroken" } })
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await screen.findByText(/Run command line 2 must use/)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("preserves identities when commands reorder and never recycles removed IDs", async () => {
    const onSave = vi.fn()
    const configured = { ...project, workflow: { runs: [{ id: "dev-id", label: "Dev", command: "pnpm dev" }, { id: "test-id", label: "Test", command: "pnpm test" }], copyFiles: [] } }
    render(<ProjectWorkflowSettings projects={[configured]} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Run commands"), { target: { value: "Test=pnpm test\nDev=pnpm dev" } })
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ runs: [{ id: "test-id", label: "Test", command: "pnpm test" }, { id: "dev-id", label: "Dev", command: "pnpm dev" }] })))
    onSave.mockClear()
    fireEvent.change(screen.getByLabelText("Run commands"), { target: { value: "New=pnpm new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ runs: [{ id: expect.stringMatching(/^run-/), label: "New", command: "pnpm new" }] }))
  })
})
