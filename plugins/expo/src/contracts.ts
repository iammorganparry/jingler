import * as v from "valibot"

export type ExpoPhase = "idle" | "starting" | "running" | "stopped" | "failed"

export const ExpoCommandInputSchema = v.object({
  sessionId: v.pipe(v.string(), v.nonEmpty())
})
export const decodeExpoCommandInput = v.parser(ExpoCommandInputSchema)

export const ExpoSessionInputSchema = v.object({
  sessionId: v.pipe(v.string(), v.nonEmpty()),
  worktreePath: v.optional(v.pipe(v.string(), v.nonEmpty()))
})
export type ExpoSessionInput = v.InferOutput<typeof ExpoSessionInputSchema>

export interface SimulatorDevice {
  readonly udid: string
  readonly name: string
  readonly state: string
}

export interface ExpoReadiness {
  readonly ready: boolean
  readonly reason?: string
  readonly simulator?: SimulatorDevice
}

export interface ExpoStatus extends ExpoReadiness {
  readonly phase: ExpoPhase
  readonly sessionId?: string
  readonly logs: readonly string[]
  readonly error?: string
}

export interface ExpoFrame {
  readonly pngBase64: string
  readonly capturedAt: number
  readonly device: SimulatorDevice
}
