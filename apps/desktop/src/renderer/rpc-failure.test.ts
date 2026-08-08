// @vitest-environment node
import { Effect, Runtime } from "effect"
import { describe, expect, it } from "vitest"
import {
  rpcFailureMessage,
  rpcFailureNumber,
  rpcFailureReason,
  rpcFailureTag,
  unwrapRpcFailure
} from "./rpc-failure.js"

describe("renderer RPC failures", () => {
  it("recovers a tagged failure from Effect's FiberFailure rejection", async () => {
    const failure = { _tag: "EnvironmentHandoffError", reason: "has-work", message: "Continue there" }
    const rejected = await Effect.runPromise(Effect.fail(failure)).catch((error) => error)

    expect(Runtime.isFiberFailure(rejected)).toBe(true)
    expect(unwrapRpcFailure(rejected)).toEqual(failure)
    expect(rpcFailureTag(rejected)).toBe("EnvironmentHandoffError")
    expect(rpcFailureReason(rejected)).toBe("has-work")
    expect(rpcFailureMessage(rejected, "fallback")).toBe("Continue there")
  })

  it("uses a fallback for an opaque transport failure", () => {
    expect(rpcFailureMessage(null, "Could not update the environment.")).toBe(
      "Could not update the environment."
    )
  })

  it("recovers numeric conflict metadata from a FiberFailure rejection", async () => {
    const rejected = await Effect.runPromise(
      Effect.fail({ _tag: "PlanConflictError", latestRevision: 7 })
    ).catch((error) => error)

    expect(rpcFailureNumber(rejected, "latestRevision")).toBe(7)
    expect(rpcFailureNumber(rejected, "missing")).toBeUndefined()
  })
})
