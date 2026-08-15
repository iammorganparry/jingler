import { describe, expect, it } from "vitest"
import {
  OFFLOAD_SANDBOX_IDLE_SECONDS,
  shouldDestroyStaleSandbox
} from "./offload-sandbox-policy.js"

describe("offload sandbox inactivity lease", () => {
  it("keeps a recently primed or used sandbox", () => {
    expect(shouldDestroyStaleSandbox(
      { lastActiveAt: 1_000 },
      1_000 + OFFLOAD_SANDBOX_IDLE_SECONDS - 1
    )).toBe(false)
  })

  it("destroys a sandbox after three inactive hours", () => {
    expect(shouldDestroyStaleSandbox(
      { lastActiveAt: 1_000 },
      1_000 + OFFLOAD_SANDBOX_IDLE_SECONDS
    )).toBe(true)
  })
})
