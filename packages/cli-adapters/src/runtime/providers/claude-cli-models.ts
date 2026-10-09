import type { Api, Model } from "@earendil-works/pi-ai"

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
