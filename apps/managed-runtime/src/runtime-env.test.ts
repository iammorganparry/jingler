import { describe, expect, it } from "vitest"
import { managedRuntimeSandboxOrigin } from "./runtime-env.js"

describe("managed runtime sandbox origin", () => {
  it("uses the public worker origin by default", () => {
    expect(
      managedRuntimeSandboxOrigin({
        MANAGED_RUNTIME_ORIGIN: "https://runtime.example"
      })
    ).toBe("https://runtime.example")
  })

  it("uses an explicit sandbox-network origin when configured", () => {
    expect(
      managedRuntimeSandboxOrigin({
        MANAGED_RUNTIME_ORIGIN: "http://127.0.0.1:9400",
        MANAGED_RUNTIME_SANDBOX_ORIGIN: "http://host.docker.internal:9400"
      })
    ).toBe("http://host.docker.internal:9400")
  })
})
