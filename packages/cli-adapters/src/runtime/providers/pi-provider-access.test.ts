import { describe, expect, it } from "vitest"
import { selectEntitlementModel } from "./pi-provider-access.js"

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
