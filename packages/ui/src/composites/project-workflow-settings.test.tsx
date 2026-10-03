import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
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
      runs: [{ id: "run-1", label: "Dev", command: "pnpm dev" }],
      copyFiles: [".env.local"],
      approve: true
    }))
    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "pnpm install --frozen-lockfile" } })
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
  })
})
