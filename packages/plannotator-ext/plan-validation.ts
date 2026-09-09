import { parsePlanMarkdown } from "./plan-parse.ts"

/** Validate the explicit, ID-tagged plan format without rejecting legacy plans. */
export const validatePlanMarkdown = (content: string): string[] => {
  if (!/^##\s+.+?<!--\s*id:\s*[\w-]+\s*-->\s*$/m.test(content)) return []

  const { stages } = parsePlanMarkdown(content)
  const errors: string[] = []
  const ids = new Set<string>()
  for (const stage of stages) {
    const label = `Stage "${stage.title}"`
    if (ids.has(stage.id)) errors.push(`${label} duplicates id "${stage.id}".`)
    ids.add(stage.id)
    if (stage.intent.trim().length === 0) errors.push(`${label} needs a one-line intent.`)
    if (stage.approach.length === 0) errors.push(`${label} needs an Approach list.`)
    if (stage.tasks.length === 0) errors.push(`${label} needs implementation steps.`)
    if (stage.notes.length === 0) errors.push(`${label} needs a Technical explanation.`)
    if (stage.acceptance.length === 0) errors.push(`${label} needs Acceptance checks.`)
    if (stage.files.length === 0) errors.push(`${label} needs proposed Files.`)
    for (const criterion of stage.acceptance) {
      if (!criterion.testReferences?.some(({ path, cases }) => path.length > 0 && cases.length > 0)) {
        errors.push(`${label} acceptance "${criterion.text}" needs a test path and named case.`)
      }
    }
  }

  for (const stage of stages) {
    for (const dependency of stage.dependencies ?? []) {
      if (!ids.has(dependency)) errors.push(`Stage "${stage.title}" depends on unknown id "${dependency}".`)
    }
  }

  const byId = new Map(stages.map((stage) => [stage.id, stage] as const))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = (byId.get(id)?.dependencies ?? []).some((dependency) =>
      byId.has(dependency) && visit(dependency)
    )
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  if (stages.some((stage) => visit(stage.id))) errors.push("Stage dependencies contain a cycle.")

  return errors
}
