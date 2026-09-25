import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentEndpointId,
  AgentModelSelection,
  RuntimeContinuation
} from "./agent-endpoint.js"

describe("agent endpoint identity", () => {
  it("keeps runtime and endpoint ownership on selections and continuations", () => {
    const endpointId = AgentEndpointId.make("desktop:claude:default")

    expect(Schema.decodeUnknownSync(AgentModelSelection)({
      runtimeId: "claude",
      endpointId,
      providerId: "anthropic",
      modelId: "anthropic/opus"
    })).toMatchObject({ runtimeId: "claude", endpointId })

    expect(Schema.decodeUnknownSync(RuntimeContinuation)({
      runtimeId: "claude",
      endpointId,
      id: "session-1"
    })).toEqual({ runtimeId: "claude", endpointId, id: "session-1" })
  })

  it("rejects unowned continuation ids", () => {
    expect(() => Schema.decodeUnknownSync(RuntimeContinuation)({ id: "session-1" })).toThrow()
  })
})
