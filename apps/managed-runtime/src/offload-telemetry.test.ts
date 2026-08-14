import { describe, expect, it } from "vitest"
import { redactedOffloadTelemetry } from "./offload-telemetry.js"

const result = {
  version: 1 as const,
  jobId: "job_aaaaaaaaaaaaaaaa",
  state: "succeeded" as const,
  exitCode: 0,
  failureReason: null,
  stdout: "private output",
  stderr: "",
  outputTruncated: false,
  timings: {
    queuedMs: 1,
    snapshotMs: 2,
    hydrationMs: 3,
    dependencyMs: 4,
    commandMs: 5
  }
}

describe("offload telemetry", () => {
  it("separates handoff phases without content or identity", () => {
    const telemetry = redactedOffloadTelemetry(result, true)
    expect(telemetry).toMatchObject({
      event: "offload_compute_settled",
      outcome: "succeeded",
      warmSandbox: true,
      timings: result.timings
    })
    const serialized = JSON.stringify(telemetry)
    expect(serialized).not.toContain(result.jobId)
    expect(serialized).not.toContain(result.stdout)
    expect(serialized).not.toContain("executable")
    expect(serialized).not.toContain("repositorySlug")
    expect(serialized).not.toContain("workingDirectory")
  })
})
