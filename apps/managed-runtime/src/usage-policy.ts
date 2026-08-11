export const BASIC_INSTANCE_CEILING_MICROUSD_PER_HOUR = 28_000

export const managedUsageCostMicrousd = (activeSeconds: number): number =>
  Math.ceil(
    (BASIC_INSTANCE_CEILING_MICROUSD_PER_HOUR * Math.max(0, activeSeconds)) /
      3_600
  )

export interface ManagedUsageTelemetry {
  readonly event: "managed_runtime_settled"
  readonly activeSeconds: number
  readonly restoreBytes: number
  readonly cleanup: "completed" | "pending"
}

/** Metrics only: identities, prompts, source, tokens, and credentials are excluded. */
export const redactedUsageTelemetry = (input: {
  readonly activeSeconds: number
  readonly restoreBytes?: number
  readonly cleanup: ManagedUsageTelemetry["cleanup"]
}): ManagedUsageTelemetry => ({
  event: "managed_runtime_settled",
  activeSeconds: input.activeSeconds,
  restoreBytes: input.restoreBytes ?? 0,
  cleanup: input.cleanup
})

export const shouldSampleUsage = (
  reservationId: string,
  sampleRate = 0.1
): boolean => {
  if (sampleRate <= 0) return false
  if (sampleRate >= 1) return true
  let hash = 2_166_136_261
  for (const character of reservationId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) / 0x1_0000_0000 < sampleRate
}
