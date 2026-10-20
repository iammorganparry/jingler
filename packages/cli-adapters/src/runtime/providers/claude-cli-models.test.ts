import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { describe, expect, it } from "vitest"
import { ProviderModelId } from "@jingler/core"
import { claudeCliModels, concreteClaudeModels } from "./claude-cli-models.js"
import { parseClaudeModelList } from "./claude-cli-model-list.js"

const resolve = async (withAliases: boolean) => {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
  if (withAliases) {
    modelRuntime.registerProvider("anthropic", {
      api: "anthropic-messages",
      models: [...claudeCliModels(getBuiltinModels("anthropic"), [])]
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
    expect(concreteClaudeModels({ worker: ProviderModelId.make("anthropic/sonnet") }, []))
      .toEqual({ worker: `anthropic/${resolved}` })
  })

  it("rewrites every alias and leaves other ids alone", () => {
    const concrete = (assignments: Record<string, ProviderModelId>) =>
      Object.values(concreteClaudeModels(assignments, []))
    expect(concrete({
      scout: ProviderModelId.make("anthropic/sonnet"),
      oracle: ProviderModelId.make("anthropic/haiku"),
      worker: ProviderModelId.make("anthropic/opus")
    }).every((model) => !/\/(opus|sonnet|haiku)$/u.test(model))).toBe(true)
    const other = { worker: ProviderModelId.make("openai-codex/gpt-5.6-sol"), scout: ProviderModelId.make("anthropic/claude-opus-5") }
    expect(concreteClaudeModels(other, [])).toEqual(other)
  })
})

// What Claude Code 2.1.286 returns from `initialize` (trimmed).
const reported = parseClaudeModelList([
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus", displayName: "Opus 5.5" },
  { value: "sonnet", displayName: "Sonnet 5.5" },
  { value: "haiku", displayName: "Haiku 4.5" },
  { value: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5" },
  { value: 42 }
])

describe("parseClaudeModelList", () => {
  it("skips default and malformed rows, and resolves aliases from the display name", () => {
    expect(reported.map(({ value, id }) => `${value}=${id}`)).toEqual([
      "opus=claude-opus-5-5",
      "sonnet=claude-sonnet-5-5",
      "haiku=claude-haiku-4-5",
      "claude-fable-5-1=claude-fable-5-1",
      "claude-sonnet-5=claude-sonnet-5"
    ])
  })

  it("returns nothing for a non-array", () => {
    expect(parseClaudeModelList(undefined)).toEqual([])
  })
})

describe("claudeCliModels with the CLI's list", () => {
  it("adds ids pi's catalogue lacks, borrowing same-family metadata", () => {
    const ids = claudeCliModels(getBuiltinModels("anthropic"), reported).map(({ id }) => id)
    expect(ids).toContain("claude-sonnet-5-5")
    expect(ids).toContain("claude-opus-5-5")
    expect(ids.filter((id) => id === "claude-sonnet-5")).toHaveLength(1)
  })

  it("resolves sonnet to the CLI's Sonnet 5.5, not pi's newest catalogue id", () => {
    expect(concreteClaudeModels({ worker: ProviderModelId.make("anthropic/sonnet") }, reported))
      .toEqual({ worker: "anthropic/claude-sonnet-5-5" })
  })
})
