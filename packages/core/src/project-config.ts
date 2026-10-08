import { Schema } from "effect"
import { ProjectWorkflow } from "./domain.js"
import { RoutineInput } from "./routines.js"

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:)/u
const UNSAFE_PATH_CHARACTER = /[\\\0]/u

/** Portable review drafts only. Local identity and consent never cross this boundary. */
export const ProjectConfigWorkflow = Schema.Struct({
  ...ProjectWorkflow.omit("approvedDigest").fields,
  copyFiles: Schema.Array(ProjectWorkflow.fields.copyFiles.value.pipe(Schema.filter((path) => {
    const trimmed = path.trim()
    return trimmed.length > 0 && !ABSOLUTE_PATH.test(trimmed) && !UNSAFE_PATH_CHARACTER.test(trimmed) &&
      trimmed.split("/").every((part) => part !== ".." && part !== "." && part.toLowerCase() !== ".git" && part.length > 0)
  },
  { message: () => "Expected a safe repository-relative path", jsonSchema: { description: "Nonempty safe relative path; no absolute paths, backslashes, nulls, empty/dot/dotdot or .git components (case insensitive)." } }))),
}).pipe(Schema.filter((workflow) => {
  const ids = new Set<string>()
  return workflow.runs.every((run) => {
    if (!run.id.trim() || !run.label.trim() || !run.command.trim() || ids.has(run.id.trim())) return false
    ids.add(run.id.trim())
    return true
  })
}, { message: () => "Run commands need unique ids, names and commands", jsonSchema: { description: "Run ids must be unique; each id, label and command must have non-whitespace content." } }))
export const ProjectRoutineTemplate = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1), Schema.filter((value) => value.trim().length > 0, { message: () => "Template id is required", jsonSchema: { pattern: "\\S" } })),
  ...RoutineInput.pick("name", "prompt", "baseBranch", "schedule", "reasoning", "maxDurationMs").fields,
  providerId: Schema.optional(RoutineInput.fields.providerId),
  modelId: Schema.optional(RoutineInput.fields.modelId),
}).pipe(Schema.filter((template) => [template.name, template.prompt, template.baseBranch].every(value => value.trim().length > 0),
{ message: () => "Name, prompt and base branch are required", jsonSchema: { description: "Name, prompt and base branch require non-whitespace content." } }))
export type ProjectRoutineTemplate = Schema.Schema.Type<typeof ProjectRoutineTemplate>
export const ProjectConfig = Schema.Struct({
  version: Schema.Literal(1),
  workflow: Schema.optional(ProjectConfigWorkflow),
  routines: Schema.optional(Schema.Array(ProjectRoutineTemplate).pipe(Schema.filter((templates) =>
    new Set(templates.map((template) => template.id)).size === templates.length,
  { message: () => "Routine template ids must be unique", jsonSchema: { description: "Template ids must be unique." } }))),
}).annotations({ parseOptions: { onExcessProperty: "error" } })
export type ProjectConfig = Schema.Schema.Type<typeof ProjectConfig>
