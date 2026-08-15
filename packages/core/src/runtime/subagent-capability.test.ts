import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  SubagentCapability,
  SubagentToolRequest
} from "./subagent-capability.js"

const capability = {
  version: 1,
  endpoint: "http://127.0.0.1:43123/v1/subagent-tool",
  token: "capability-token",
  parentPiSessionId: "parent-session",
  agent: "worker",
  targetId: "desktop",
  role: "conversation",
  mode: "ask",
  tools: [{
    id: "workspace_read_file",
    description: "Read a workspace file",
    inputSchema: { type: "object" },
    risk: "read"
  }]
} as const

describe("subagent capability contracts", () => {
  it("round-trips a bounded launch capability", () => {
    expect(Schema.decodeUnknownSync(SubagentCapability)(capability)).toEqual(
      capability
    )
  })

  it("rejects an unknown wire version", () => {
    expect(() =>
      Schema.decodeUnknownSync(SubagentToolRequest)({
        version: 2,
        token: "token",
        parentPiSessionId: "parent",
        callId: "call",
        toolId: "workspace_read_file",
        arguments: {}
      })
    ).toThrow()
  })
})
