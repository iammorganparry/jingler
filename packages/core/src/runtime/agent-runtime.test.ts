import { CURRENT_RUNTIME_CONTRACTS } from "./model-certification.js"
import { runtimeCapabilitiesMatch } from "./agent-runtime.js"
import { describe, expect, it } from "vitest"

const local = {
  versions: CURRENT_RUNTIME_CONTRACTS,
  toolIds: ["workspace.read", "jingler.question"],
  resourceIds: ["skill.review"],
  targetId: "desktop"
}

describe("agent runtime contract", () => {
  it("accepts a target with the exact contracts and required inventories", () => {
    expect(runtimeCapabilitiesMatch(local, local)).toBe(true)
  })

  it("rejects remote contract drift or missing tools", () => {
    expect(runtimeCapabilitiesMatch(local, {
      ...local,
      versions: { ...CURRENT_RUNTIME_CONTRACTS, diff: "old" }
    })).toBe(false)
    expect(runtimeCapabilitiesMatch(local, { ...local, toolIds: [] })).toBe(false)
    expect(runtimeCapabilitiesMatch(local, { ...local, targetId: "other-device" })).toBe(false)
  })
})
