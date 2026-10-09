import { createHash } from "node:crypto"
import { isAbsolute, normalize, sep } from "node:path"
import { ProjectWorkflow as ProjectWorkflowSchema } from "@jingler/core"
import type { ProjectWorkflow } from "@jingler/core"
import { Schema } from "effect"

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

// Decode-only compatibility: these fields are never exposed or executed.
const legacyPort = Schema.Int.pipe(Schema.between(1024, 65535))
const legacyWorkflow = Schema.Struct({
  ...ProjectWorkflowSchema.fields,
  ports: Schema.optional(Schema.Struct({
    primary: legacyPort,
    extras: Schema.Array(Schema.Struct({ name: Schema.String, start: legacyPort })),
    previewUrl: Schema.optional(Schema.String),
  })),
})
const verifiedLegacyDigest = (workflow: object & { ports: unknown }): string | undefined => {
  const value = Schema.decodeUnknownOption(legacyWorkflow)(workflow)
  if (value._tag === "None") return undefined
  // The old canonical payload included the complete ports object, with its
  // persisted ordering, before setup/cleanup/runs/copyFiles.
  const payload = { ...(workflow.ports ? { ports: workflow.ports } : {}), ...canonical(value.value) }
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  return value.value.approvedDigest === digest ? digest : undefined
}
export interface LegacyWorkflowBinding { readonly projectId: string; readonly oldDigest: string; readonly newDigest: string }

/** Extract proof only from the complete, still-approved legacy payload. */
export const legacyWorkflowBinding = (project: unknown): LegacyWorkflowBinding | undefined => {
  if (typeof project !== "object" || project === null || !("id" in project) || typeof project.id !== "string" || !("workflow" in project)) return undefined
  const workflow = project.workflow
  if (typeof workflow !== "object" || workflow === null || !("ports" in workflow)) return undefined
  const oldDigest = verifiedLegacyDigest(workflow)
  return oldDigest ? { projectId: project.id, oldDigest, newDigest: workflowDigest(Schema.decodeUnknownSync(ProjectWorkflowSchema)(workflow)) } : undefined
}

/** Verify legacy consent before the current schema discards the removed fields. */
export const migrateProjectWorkflow = (project: unknown): unknown => {
  if (typeof project !== "object" || project === null || !("workflow" in project)) return project
  const workflow = project.workflow
  if (typeof workflow !== "object" || workflow === null || !("ports" in workflow)) return project
  const decoded = Schema.decodeUnknownSync(ProjectWorkflowSchema)(workflow)
  return { ...project, workflow: normalizeWorkflow(decoded, verifiedLegacyDigest(workflow) !== undefined) }
}
