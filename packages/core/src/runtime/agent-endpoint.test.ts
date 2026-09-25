import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentEndpoint,
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

it("requires complete, well-typed endpoint capabilities", () => {
  const endpoint = {
    id: "desktop:claude:default", runtimeId: "claude", targetId: "desktop",
    label: "Claude", status: "ready", version: "2.1.0",
    features: { steer: "text", planReview: false, subagentFleet: false, backgroundTasks: false }
  }
  expect(Schema.decodeUnknownSync(AgentEndpoint)(endpoint)).toEqual(endpoint)
  for (const features of [undefined, null, {}, { ...endpoint.features, steer: "yes" },
    { ...endpoint.features, planReview: "false" }, { ...endpoint.features, backgroundTasks: undefined }]) {
    expect(() => Schema.decodeUnknownSync(AgentEndpoint)({ ...endpoint, features })).toThrow()
  }
})

it("keeps endpoint metadata secret-free under strict transport decoding", () => {
  expect(Object.keys(AgentEndpoint.fields).sort()).toEqual([
    "features", "id", "label", "protocolVersion", "runtimeId", "status", "targetId", "version"
  ])
  const endpoint = {
    id: "device:claude:default", runtimeId: "claude", targetId: "device", label: "Claude",
    status: "ready", version: "2.1.282", features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false }
  }
  const decode = Schema.decodeUnknownSync(AgentEndpoint, { onExcessProperty: "error" })
  expect(decode(endpoint)).toEqual(endpoint)
  for (const key of ["accessToken", "refreshToken", "token", "credentials"]) {
    expect(() => decode({ ...endpoint, [key]: "secret" })).toThrow()
  }
})
