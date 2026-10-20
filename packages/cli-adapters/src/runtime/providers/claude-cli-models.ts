import type { Api, Model } from "@earendil-works/pi-ai"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { ProviderModelId, type SubagentModelAssignments } from "@jingler/core"
import { cachedClaudeModels, type ClaudeCliModel } from "./claude-cli-model-list.js"

/** The pi catalogue entry closest to `id`: same family, newest first. */
const nearest = (models: ReadonlyArray<Model<Api>>, id: string): Model<Api> | undefined => {
  const family = /^claude-([a-z]+)/u.exec(id)?.[1]
  return family === undefined
    ? undefined
    : models
      .filter((model) => model.id.startsWith(`claude-${family}`) && !/-\d{8}$/u.test(model.id))
      .sort((left, right) => right.id.localeCompare(left.id, "en", { numeric: true }))[0]
}

/**
 * The Anthropic catalog plus every id Claude CLI reports that pi's static
 * catalog omits (metadata borrowed from the nearest same-family model), plus
 * the `opus`/`sonnet`/`haiku` aliases. Parent and child sessions must register
 * the same list: a child without the `sonnet` alias resolves it to a concrete
 * id, and pi-subagents then fails the run with `model_verification_failed`.
 */
export const claudeCliModels = (
  models: ReadonlyArray<Model<Api>>,
  cli: ReadonlyArray<ClaudeCliModel> = cachedClaudeModels()
): ReadonlyArray<Model<Api>> => {
  const known = new Set(models.map(({ id }) => id))
  const reported = cli.flatMap(({ id, displayName }) => {
    const base = known.has(id) ? undefined : nearest(models, id)
    if (base === undefined) return []
    known.add(id)
    return [{ ...base, id, name: `Claude ${displayName}` }]
  })
  const all = [...models, ...reported]
  const aliases = ([
    ["opus", "claude-opus", "Claude Opus (latest)"],
    ["sonnet", "claude-sonnet", "Claude Sonnet (latest)"],
    ["haiku", "claude-haiku", "Claude Haiku (latest)"]
  ] as const).flatMap(([id, prefix, name]) => {
    const base = all.find((model) => model.id.startsWith(prefix))
    return base === undefined || known.has(id) ? [] : [{ ...base, id, name }]
  })
  return [...all, ...aliases]
}

const ALIAS_PREFIX: Readonly<Record<string, string>> = {
  opus: "claude-opus",
  sonnet: "claude-sonnet",
  haiku: "claude-haiku"
}

/**
 * The concrete id behind an alias: what Claude CLI itself says (`sonnet` →
 * Sonnet 5.5), else the newest undated pi catalogue id.
 */
const latestConcrete = (alias: string, cli: ReadonlyArray<ClaudeCliModel>): string | undefined =>
  cli.find(({ value }) => value === alias)?.id ?? getBuiltinModels("anthropic")
    .map(({ id }) => id)
    .filter((id) => id.startsWith(ALIAS_PREFIX[alias]!) && !/-\d{8}$/u.test(id))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .at(-1)

/**
 * Profiles always carry the concrete Claude id, whatever the route. A child
 * (CLI or not) reports the concrete model it ran, and pi-subagents compares
 * that as text against the launch candidate, so an alias such as
 * `anthropic/sonnet` fails with `model_verification_failed`.
 */
export const concreteClaudeModels = (
  models: SubagentModelAssignments,
  cli: ReadonlyArray<ClaudeCliModel> = cachedClaudeModels()
): SubagentModelAssignments =>
  Object.fromEntries(Object.entries(models).map(([agent, model]) => {
    const alias = String(model).replace(/^anthropic\//u, "")
    const concrete = String(model).startsWith("anthropic/") && alias in ALIAS_PREFIX
      ? latestConcrete(alias, cli)
      : undefined
    return [agent, concrete === undefined ? model : ProviderModelId.make(`anthropic/${concrete}`)]
  }))
