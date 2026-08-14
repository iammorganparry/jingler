export type ExpoPhase = "idle" | "starting" | "running" | "stopped" | "failed"

export interface ExpoSessionInput {
  readonly sessionId: string
  readonly worktreePath?: string
}

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
