import { expect, it, vi } from "vitest"
import { normalizeWorkflow, requireApprovedWorkflow, readyWorkspacePreview } from "./project-workflow.js"
it("revoked workflow approval prevents any preview fetch", async () => {
  const fetch = vi.fn()
  const approved = normalizeWorkflow({ runs: [], copyFiles: [], ports: { primary: 3100, extras: [], previewUrl: "http://localhost:{port}" } }, true)
  const changed = normalizeWorkflow({ ...approved, ports: { primary: 3100, extras: [], previewUrl: "http://localhost:{port}/changed" } }, false)
  await expect(readyWorkspacePreview(changed, { primary: 3100, extras: {} }, fetch)).rejects.toThrow("Approve the current")
  expect(fetch).not.toHaveBeenCalled()
  expect(() => requireApprovedWorkflow(approved)).not.toThrow()
})
