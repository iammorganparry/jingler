import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { describe, expect, it } from "vitest"
import { ProviderModelId } from "@jingler/core"
import { claudeCliModels, concreteClaudeModels } from "./claude-cli-models.js"

const resolve = async (withAliases: boolean) => {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
  if (withAliases) {
    modelRuntime.registerProvider("anthropic", {
      api: "anthropic-messages",
      models: [...claudeCliModels(getBuiltinModels("anthropic"))]
    })
  }
  return resolveCliModel({ cliModel: "anthropic/sonnet:low", modelRuntime }).model?.id
}

describe("Claude CLI child model aliases", () => {
  it("keeps `sonnet` as the model id so pi-subagents verification matches", async () => {
    expect(await resolve(true)).toBe("sonnet")
  })

  it("without the aliases the child fuzzy-matches to a concrete id (the bug)", async () => {
    expect(await resolve(false)).not.toBe("sonnet")
  })
})

describe("concreteClaudeModels", () => {
  // The child reports the concrete id it ran; pi-subagents compares it as text with the
  // profile model, so every route (Claude CLI included) must write the concrete id.
  it("writes the id a child resolves for an alias", async () => {
    const resolved = await resolve(false)
    expect(resolved).toMatch(/^claude-sonnet/u)
    expect(concreteClaudeModels({ worker: ProviderModelId.make("anthropic/sonnet") }))
      .toEqual({ worker: `anthropic/${resolved}` })
  })

  it("rewrites every alias and leaves other ids alone", () => {
    const concrete = (assignments: Record<string, ProviderModelId>) =>
      Object.values(concreteClaudeModels(assignments))
    expect(concrete({
      scout: ProviderModelId.make("anthropic/sonnet"),
      oracle: ProviderModelId.make("anthropic/haiku"),
      worker: ProviderModelId.make("anthropic/opus")
    }).every((model) => !/\/(opus|sonnet|haiku)$/u.test(model))).toBe(true)
    const other = { worker: ProviderModelId.make("openai-codex/gpt-5.6-sol"), scout: ProviderModelId.make("anthropic/claude-opus-5") }
    expect(concreteClaudeModels(other)).toEqual(other)
  })
})
