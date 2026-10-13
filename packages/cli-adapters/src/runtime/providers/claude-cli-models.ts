import type { Api, Model } from "@earendil-works/pi-ai"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { ProviderModelId, type SubagentModelAssignments } from "@jingler/core"

/**
 * The Anthropic catalog plus the ids Claude CLI accepts that pi's static
 * catalog omits. Parent and child sessions must register the same list: a
 * child without the `sonnet` alias resolves it to a concrete id, and
 * pi-subagents then fails the run with `model_verification_failed`.
 */
export const claudeCliModels = (models: ReadonlyArray<Model<Api>>): ReadonlyArray<Model<Api>> => {
  const has = (id: string) => models.some((model) => model.id === id)
  const aliases = ([
    ["opus", "claude-opus", "Claude Opus (latest)"],
    ["sonnet", "claude-sonnet", "Claude Sonnet (latest)"],
    ["haiku", "claude-haiku", "Claude Haiku (latest)"]
  ] as const).flatMap(([id, prefix, name]) => {
    const base = models.find((model) => model.id.startsWith(prefix))
    return base === undefined || has(id) ? [] : [{ ...base, id, name }]
  })
  // Claude CLI ships this id before pi's catalogue; inherit metadata until pi catches up.
  const opus5 = models.find(({ id }) => id === "claude-opus-5")
  const opus55 = opus5 === undefined || has("claude-opus-5-5")
    ? []
    : [{ ...opus5, id: "claude-opus-5-5", name: "Claude Opus 5.5" }]
  return [...models, ...aliases, ...opus55]
}

const ALIAS_PREFIX: Readonly<Record<string, string>> = {
  opus: "claude-opus",
  sonnet: "claude-sonnet",
  haiku: "claude-haiku"
}

/** The newest undated catalogue id for an alias, which is what a child without the alias resolves. */
const latestConcrete = (alias: string): string | undefined =>
  getBuiltinModels("anthropic")
    .map(({ id }) => id)
    .filter((id) => id.startsWith(ALIAS_PREFIX[alias]!) && !/-\d{8}$/u.test(id))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .at(-1)

/**
 * Only the Claude CLI route registers the aliases in a child. On any other
 * Anthropic route the child fuzzy-resolves `sonnet` to a concrete id and
 * pi-subagents fails the run with `model_verification_failed`, so the parent
 * writes the concrete id into the profile instead.
 */
export const concreteClaudeModels = (
  models: SubagentModelAssignments,
  cliRoute: boolean
): SubagentModelAssignments =>
  cliRoute
    ? models
    : Object.fromEntries(Object.entries(models).map(([agent, model]) => {
        const alias = String(model).replace(/^anthropic\//u, "")
        const concrete = String(model).startsWith("anthropic/") && alias in ALIAS_PREFIX
          ? latestConcrete(alias)
          : undefined
        return [agent, concrete === undefined ? model : ProviderModelId.make(`anthropic/${concrete}`)]
      }))
