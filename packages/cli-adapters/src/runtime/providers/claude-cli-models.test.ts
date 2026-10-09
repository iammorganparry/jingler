import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { describe, expect, it } from "vitest"
import { claudeCliModels } from "./claude-cli-models.js"

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
