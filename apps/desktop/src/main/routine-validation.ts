import type { Project, ProviderCatalog, RoutineInput } from "@jingler/core"
import { piEndpointId } from "@jingler/core"
import { approvedWorkflow, workflowDigest } from "@jingler/cli-adapters/project-workflow"
export function validateRoutineProject(input: RoutineInput, project: Project, expectedDigest?: string | null, platform = process.platform) {
  if (input.runtimeId !== "pi" || platform === "win32") throw new Error("Routines require supported local managed Pi execution.")
  if (project.availability !== "available" || project.environmentId || project.workflow?.setup) throw new Error("Routines require a local project without arbitrary setup shell commands.")
  const digest = project.workflow ? workflowDigest(project.workflow) : null
  if (project.workflow && !approvedWorkflow(project.workflow)) throw new Error("Approve the current project workflow before saving or running a routine.")
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new Error("Project workflow approval changed. Review and save the routine again.")
  return digest
}
export function validateRoutineModel(input: RoutineInput, catalog: ProviderCatalog) {
  const entry = catalog.connections.find(({ connection }) => connection.status === "authenticated" && connection.targetId === "desktop" && connection.id === input.connectionId && piEndpointId(connection.targetId, connection.id) === input.endpointId)
  const model = entry?.models.find(model => model.providerId === input.providerId && model.id === input.modelId && model.selectable)
  if (!model) throw new Error("Saved Pi connection/model is unavailable; no fallback was selected.")
  if (input.reasoning?.enabled && (!input.reasoning.effort || !model.capabilities.reasoning.includes(input.reasoning.effort))) throw new Error("Saved reasoning effort is unsupported; choose a supported effort or provider default.")
  if (input.reasoning?.enabled === false && !model.capabilities.reasoningCanDisable) throw new Error("This model cannot disable reasoning; no fallback was selected.")
  return model
}
