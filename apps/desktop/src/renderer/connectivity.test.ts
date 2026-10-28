import { describe, expect, it } from "vitest"
import { isOffline, isQuotaFailure, isTransportFailure, RPC_FAILURE_THRESHOLD } from "./connectivity.js"

describe("connectivity heuristic", () => {
  it("is offline when the OS says so", () => {
    expect(isOffline({ navigatorOnline: false, consecutiveRpcFailures: 0 })).toBe(true)
  })
  it("is offline after repeated transport failures despite navigator.onLine", () => {
    expect(isOffline({ navigatorOnline: true, consecutiveRpcFailures: RPC_FAILURE_THRESHOLD - 1 })).toBe(false)
    expect(isOffline({ navigatorOnline: true, consecutiveRpcFailures: RPC_FAILURE_THRESHOLD })).toBe(true)
  })
  it("tagged domain failures are not transport failures", () => {
    expect(isTransportFailure({ _tag: "EnvironmentHandoffError" })).toBe(false)
    expect(isTransportFailure(new Error("socket closed"))).toBe(true)
  })
  it("recognises relay quota failures", () => {
    expect(isQuotaFailure({ _tag: "DeviceControlPlaneError", reason: "quota-exceeded" })).toBe(true)
    expect(isQuotaFailure({ reason: "offline" })).toBe(false)
  })
})
