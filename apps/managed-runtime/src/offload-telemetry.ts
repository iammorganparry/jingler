import type { OffloadJobResult } from "@jingler/core"

export interface OffloadSettledTelemetry {
  readonly event: "offload_compute_settled"
  readonly outcome: OffloadJobResult["state"]
  readonly failureReason: OffloadJobResult["failureReason"]
  readonly warmSandbox: boolean
  readonly outputTruncated: boolean
  readonly timings: OffloadJobResult["timings"]
}

/** Aggregate-only telemetry: no account, job, command, output, repository, or path. */
export const redactedOffloadTelemetry = (
  result: OffloadJobResult,
  warmSandbox: boolean
): OffloadSettledTelemetry => ({
  event: "offload_compute_settled",
  outcome: result.state,
  failureReason: result.failureReason,
  warmSandbox,
  outputTruncated: result.outputTruncated,
  timings: result.timings
})
