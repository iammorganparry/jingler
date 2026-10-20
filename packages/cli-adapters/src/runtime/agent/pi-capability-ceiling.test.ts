import {
  registerSubagentCapabilityCeiling,
  resolveCurrentSubagentCapabilityCeiling
} from "pi-subagents/capability-ceiling"
import { describe, expect, it } from "vitest"
import { registerParentCapabilityCeiling } from "./pi-session-factory.js"

describe("registerParentCapabilityCeiling", () => {
  it("is found by the session file, which pi-subagents resolves before the session id", () => {
    const handle = registerParentCapabilityCeiling({ registerSubagentCapabilityCeiling }, ["pi-session-id", "/sessions/parent.jsonl"], {
      source: "jingler-runtime",
      ceiling: { allowedTools: ["workspace_read_file", "subagent"], denyExtensions: false }
    })
    for (const id of ["pi-session-id", "/sessions/parent.jsonl"]) {
      expect(resolveCurrentSubagentCapabilityCeiling(id)?.allowedTools)
        .toEqual(["subagent", "workspace_read_file"])
    }
    handle.dispose()
    expect(resolveCurrentSubagentCapabilityCeiling("/sessions/parent.jsonl")).toBeUndefined()
    expect(resolveCurrentSubagentCapabilityCeiling("pi-session-id")).toBeUndefined()
  })

  it("skips a missing session file", () => {
    const handle = registerParentCapabilityCeiling({ registerSubagentCapabilityCeiling }, ["only-id", undefined], {
      source: "jingler-runtime",
      ceiling: { allowedTools: ["subagent"] }
    })
    expect(resolveCurrentSubagentCapabilityCeiling("only-id")?.allowedTools).toEqual(["subagent"])
    handle.dispose()
  })
})
