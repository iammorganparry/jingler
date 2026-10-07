import { describe, expect, it } from "vitest"
import {
  approvedWorkflow,
  normalizeWorkflow,
  safeWorkflowRelativePath,
  workflowDigest
} from "./project-workflow.js"

const draft = {
  setup: " pnpm install ",
  cleanup: " pnpm clean ",
  runs: [{ id: "dev", label: "Dev", command: "pnpm dev" }],
  copyFiles: [".env.local"]
}

describe("project workflow approval", () => {
  it("binds approval to the exact normalized executable content", () => {
    const approved = normalizeWorkflow(draft, true)
    expect(approved.approvedDigest).toBe(workflowDigest(approved))
    expect(approvedWorkflow(approved)).toEqual(approved)
    expect(approvedWorkflow({ ...approved, setup: "curl attacker" })).toBeUndefined()
  })

  it("stores unapproved edits without a stale consent digest", () => {
    expect(normalizeWorkflow(draft, false).approvedDigest).toBeUndefined()
  })

  it.each(["../secret", "/etc/passwd", ".git/config", ".git/objects/x", ""])(
    "rejects unsafe copied-file path %j",
    (path) => expect(safeWorkflowRelativePath(path)).toBeNull()
  )

  it("accepts a safe repository-relative ignored-file path", () => {
    expect(safeWorkflowRelativePath("config/.env.local")).toBe("config/.env.local")
  })
})

 it("binds approval to port names, values and preview templates", () => {
   const draft = { runs: [], copyFiles: [], ports: { primary: 3100, extras: [{ name: "API", start: 3101 }], previewUrl: "http://localhost:{port}" } }
   const approved = normalizeWorkflow(draft, true)
   expect(approvedWorkflow(approved)).toBeDefined()
   expect(approvedWorkflow({ ...approved, ports: { ...draft.ports, previewUrl: "http://localhost:{API_port}" } })).toBeUndefined()
   expect(() => normalizeWorkflow({ ...draft, ports: { ...draft.ports, previewUrl: "file:///etc/passwd" } }, true)).toThrow()
 })
