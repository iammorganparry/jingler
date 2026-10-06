import { validateWorkspacePortConfig, resolveWorkspacePreview } from "./workspace-ports.js"
import { createHash } from "node:crypto"
import { isAbsolute, normalize, sep } from "node:path"
import type { ProjectWorkflow } from "@jingler/core"

export type WorkflowDraft = Omit<ProjectWorkflow, "approvedDigest">

const canonical = (workflow: WorkflowDraft): WorkflowDraft => ({
  ...(workflow.ports ? { ports: workflow.ports } : {}),
  ...(workflow.setup?.trim() ? { setup: workflow.setup.trim() } : {}),
  ...(workflow.cleanup?.trim() ? { cleanup: workflow.cleanup.trim() } : {}),
  runs: workflow.runs.map((run) => ({
    id: run.id.trim(),
    label: run.label.trim(),
    command: run.command.trim()
  })),
  copyFiles: workflow.copyFiles.map((entry) => entry.trim()).filter(Boolean)
})

export const workflowDigest = (workflow: WorkflowDraft): string =>
  createHash("sha256").update(JSON.stringify(canonical(workflow))).digest("hex")

export const approvedWorkflow = (workflow: ProjectWorkflow | undefined): ProjectWorkflow | undefined =>
  workflow !== undefined && workflow.approvedDigest === workflowDigest(workflow) ? workflow : undefined

/** Only repository-relative paths can cross from the registered root into a worktree. */
export const safeWorkflowRelativePath = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\0")) return null
  const path = normalize(trimmed)
  const folded = path.toLocaleLowerCase("en-US")
  if (folded === ".git" || folded.startsWith(`.git${sep}`) || path === ".." || path.startsWith(`..${sep}`)) return null
  return path
}

export const normalizeWorkflow = (workflow: WorkflowDraft, approve: boolean): ProjectWorkflow => {
  if (workflow.ports) validateWorkspacePortConfig(workflow.ports)
  const value = canonical(workflow)
  return approve ? { ...value, approvedDigest: workflowDigest(value) } : value
}

export const requireApprovedWorkflow = (workflow: ProjectWorkflow | undefined): ProjectWorkflow => {
  const approved = approvedWorkflow(workflow)
  if (!approved) throw new Error("Approve the current project workflow before opening its preview.")
  return approved
}

/** Approval is checked before URL resolution and before the first network request. */
export const readyWorkspacePreview = async (workflow: ProjectWorkflow | undefined, ports: import("@jingler/core").WorkspacePorts, request: typeof fetch = globalThis.fetch): Promise<string> => {
  const approved = requireApprovedWorkflow(workflow)
  const url = resolveWorkspacePreview(approved.ports?.previewUrl ?? "http://localhost:{port}", ports)
  try {
    const response = await request(url, { signal: AbortSignal.timeout(3000), redirect: "error" })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (cause) { throw new Error(`Preview is not ready at ${url}. Start the server and retry. ${cause instanceof Error ? cause.message : ""}`) }
  return url
}
