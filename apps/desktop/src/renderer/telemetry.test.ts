import { beforeEach, describe, expect, it, vi } from "vitest"

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn()
}))
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({ default: posthog }))

const load = async () => {
  vi.resetModules()
  return import("./telemetry.js")
}

describe("telemetryState", () => {
  it("is off without a key, whatever the operator chose", async () => {
    const { telemetryState } = await load()
    expect(telemetryState(undefined, true)).toBe("off")
    expect(telemetryState("", undefined)).toBe("off")
  })

  it("treats absent config as opted in and only an explicit false as out", async () => {
    const { telemetryState } = await load()
    expect(telemetryState("k", undefined)).toBe("in")
    expect(telemetryState("k", true)).toBe("in")
    expect(telemetryState("k", false)).toBe("out")
  })
})

describe("applyTelemetry", () => {
  beforeEach(() => vi.clearAllMocks())

  it("never starts without a key or under e2e", async () => {
    const { applyTelemetry } = await load()
    applyTelemetry(true, undefined, false)
    applyTelemetry(true, "k", true)
    expect(posthog.init).not.toHaveBeenCalled()
  })

  it("does not start for an operator who opted out", async () => {
    const { applyTelemetry } = await load()
    applyTelemetry(false, "k", false)
    expect(posthog.init).not.toHaveBeenCalled()
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled()
  })

  it("inits once with masking, then opts out and back in on toggle", async () => {
    const { applyTelemetry } = await load()
    applyTelemetry(undefined, "k", false)
    expect(posthog.init).toHaveBeenCalledOnce()
    expect(posthog.init.mock.calls[0]?.[1]).toMatchObject({
      disable_external_dependency_loading: true,
      session_recording: { maskAllInputs: true, maskTextSelector: "*" }
    })
    applyTelemetry(false, "k", false)
    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce()
    applyTelemetry(true, "k", false)
    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce()
    expect(posthog.init).toHaveBeenCalledOnce()
  })
})
