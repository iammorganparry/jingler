import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { recordRemoteContractObservation } from "./pi-scenario-runner.js"

const expected = {
  versions: CURRENT_RUNTIME_CONTRACTS,
  toolIds: ["workspace_read"],
  resourceIds: ["managed-skill"],
  targetId: "cloud"
}

describe("remote scenario preflight", () => {
  it("records acceptance for an independently supplied compatible target", () => {
    expect(recordRemoteContractObservation(expected, {
      versions: { ...CURRENT_RUNTIME_CONTRACTS },
      toolIds: ["workspace_read", "workspace_list"],
      resourceIds: ["managed-skill"],
      targetId: "cloud"
    })).toEqual({ kind: "event", tag: "RemoteContractAccepted" })
  })

  it("rejects a target with stale runtime contracts", () => {
    expect(() => recordRemoteContractObservation(expected, {
      versions: { ...CURRENT_RUNTIME_CONTRACTS, tools: "stale" },
      toolIds: ["workspace_read"],
      resourceIds: ["managed-skill"],
      targetId: "cloud"
    })).toThrow("execution target runtime contract mismatch")
  })
})
