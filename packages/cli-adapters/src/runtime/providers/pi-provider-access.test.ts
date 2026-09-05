import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  classifyObservedBillingRoute,
  modelReasoningCapabilities,
  registerJinglerModels,
  selectEntitlementModel,
} from "./pi-provider-access.js"

describe("Jingler model additions", () => {
  it("adds GPT-6 Astra to the configured Codex route", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    runtime.registerProvider("openai-codex", { baseUrl: "https://codex-proxy.example.com" })

    registerJinglerModels(runtime)

    expect(runtime.getModel("openai-codex", "gpt-6-astra")).toMatchObject({
      baseUrl: "https://codex-proxy.example.com",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
    })
  })
})

describe("observed provider billing routes", () => {
  it("confirms Codex subscription only on the ChatGPT backend", () => {
    expect(classifyObservedBillingRoute("openai-codex-oauth", {
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api"
    })).toBe("subscription")
    expect(classifyObservedBillingRoute("openai-codex-oauth", {
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1"
    })).toBeNull()
  })

  it("confirms Claude subscription on pi's Anthropic OAuth route", () => {
    expect(classifyObservedBillingRoute("claude-setup-token", {
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com"
    })).toBe("subscription")
    expect(classifyObservedBillingRoute("claude-setup-token", {
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com"
    })).toBeNull()
  })
})

const models = [
  { id: "claude-fable-5" },
  { id: "claude-haiku-4-5" },
  { id: "claude-sonnet-5" }
] as const

describe("selectEntitlementModel", () => {
  it("uses a broadly available Claude model for setup-token connection validation", () => {
    expect(selectEntitlementModel(models, "claude-setup-token")).toEqual({
      id: "claude-haiku-4-5"
    })
  })

  it("keeps catalog order for routes without a dedicated entitlement model", () => {
    expect(selectEntitlementModel(models, "api-key")).toEqual({
      id: "claude-fable-5"
    })
  })

  it("fails when the provider exposes no authenticated model", () => {
    expect(() => selectEntitlementModel([], "claude-setup-token")).toThrow(
      "No authenticated model is available"
    )
  })
})

describe("supportedReasoningEfforts", () => {
  it("uses pi's model-specific thinking map including adaptive Claude levels", () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: "xhigh",
        max: "max"
      }
    } as Model<Api>

    expect(modelReasoningCapabilities(model)).toEqual({
      reasoning: ["low", "medium", "high", "xhigh", "max"],
      reasoningCanDisable: true,
      reasoningDefault: "medium"
    })
  })

  it("returns no effort controls for a non-reasoning model", () => {
    expect(modelReasoningCapabilities({ reasoning: false } as Model<Api>)).toEqual({
      reasoning: [],
      reasoningCanDisable: true
    })
  })

  it("preserves pi's model-specific ability to disable reasoning", () => {
    expect(modelReasoningCapabilities({
      reasoning: true,
      thinkingLevelMap: { off: null, medium: null }
    } as Model<Api>)).toEqual({
      reasoning: ["minimal", "low", "high"],
      reasoningCanDisable: false,
      reasoningDefault: "high"
    })
  })
})
