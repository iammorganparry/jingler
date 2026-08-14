import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  classifyObservedBillingRoute,
  modelReasoningCapabilities,
  selectEntitlementModel,
} from "./pi-provider-access.js"

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

  it("does not mislabel Anthropic paid extra usage as Claude plan usage", () => {
    expect(classifyObservedBillingRoute("claude-setup-token", {
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com"
    })).toBe("api")
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
