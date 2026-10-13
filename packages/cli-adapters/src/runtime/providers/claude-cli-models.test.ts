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
  // A child whose Anthropic credential is not the Claude CLI route never registers the
  // `sonnet` alias, so the parent must write the id that child would resolve to.
  it("writes the id an alias-less child resolves when the route is not the Claude CLI", async () => {
    const resolved = await resolve(false)
    expect(concreteClaudeModels({ worker: ProviderModelId.make("anthropic/sonnet") }, false))
      .toEqual({ worker: `anthropic/${resolved}` })
  })

  it("keeps aliases on the Claude CLI route and leaves other ids alone", () => {
    const assignments = { worker: ProviderModelId.make("anthropic/sonnet") }
    expect(concreteClaudeModels(assignments, true)).toEqual(assignments)
    const other = { worker: ProviderModelId.make("openai-codex/gpt-5.6-sol"), scout: ProviderModelId.make("anthropic/claude-opus-5") }
    expect(concreteClaudeModels(other, false)).toEqual(other)
  })
})
