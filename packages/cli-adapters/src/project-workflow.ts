import { createHash } from "node:crypto"
import { isAbsolute, normalize, sep } from "node:path"
import type { ProjectWorkflow } from "@jingler/core"

export type WorkflowDraft = Omit<ProjectWorkflow, "approvedDigest">

const canonical = (workflow: WorkflowDraft): WorkflowDraft => ({
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
  const value = canonical(workflow)
  return approve ? { ...value, approvedDigest: workflowDigest(value) } : value
}
