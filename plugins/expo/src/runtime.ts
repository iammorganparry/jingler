import * as v from "valibot"
import type {
  ExpoFrame,
  ExpoReadiness,
  ExpoSessionInput,
  ExpoStatus,
  SimulatorDevice
} from "./contracts.js"

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ProcessListeners {
  readonly output: (chunk: string) => void
  readonly exit: (code: number | null, signal: string | null) => void
}

export interface ManagedProcess {
  readonly write: (input: string) => Promise<void>
  readonly terminate: () => Promise<void>
}

export interface ExpoRuntimeDependencies {
  readonly platform: NodeJS.Platform
  readonly exists: (path: string) => Promise<boolean>
  readonly exec: (
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string; readonly timeoutMs?: number }
  ) => Promise<CommandResult>
  readonly spawn: (
    executable: string,
    args: readonly string[],
    cwd: string,
    listeners: ProcessListeners
  ) => Promise<ManagedProcess>
  readonly capture: (udid: string) => Promise<string>
  readonly openSimulator: () => Promise<void>
  readonly now: () => number
}

const SimctlDeviceSchema = v.object({
  udid: v.string(),
  name: v.string(),
  state: v.string(),
  isAvailable: v.optional(v.boolean())
})
const SimctlPayloadSchema = v.object({
  devices: v.record(v.string(), v.array(SimctlDeviceSchema))
})
const decodeSimctlPayload = v.parser(SimctlPayloadSchema)

const TRAILING_SLASH = /\/$/u
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
const READY_OUTPUT = /(?:Metro waiting|Waiting on|Opening (?:the app )?on iOS|exp:\/\/)/i
const MAX_LOG_LINES = 100

const cleanLine = (line: string, worktreePath?: string): string => {
  const withoutAnsi = line.replace(ANSI, "").replaceAll("\r", "").trimEnd()
  return worktreePath ? withoutAnsi.replaceAll(worktreePath, "<worktree>") : withoutAnsi
}

export const parseSimulatorDevices = (json: string): readonly SimulatorDevice[] => {
  try {
    const { devices } = decodeSimctlPayload(JSON.parse(json))
    return Object.values(devices)
      .flat()
      .filter(({ isAvailable }) => isAvailable !== false)
      .map(({ udid, name, state }) => ({ udid, name, state }))
  } catch {
    throw new Error("Xcode returned invalid Simulator device data.")
  }
}

const failure = (reason: string): ExpoReadiness => ({ ready: false, reason })

export class ExpoPreviewController {
  private process: ManagedProcess | null = null
  private phase: ExpoStatus["phase"] = "idle"
  private owner: ExpoSessionInput | null = null
  private logs: string[] = []
  private error: string | undefined
  private simulator: SimulatorDevice | null = null
  private generation = 0
  private lifecycle = Promise.resolve()
  private captureInFlight: {
    readonly generation: number
    readonly promise: Promise<ExpoFrame>
  } | null = null

  constructor(private readonly deps: ExpoRuntimeDependencies) {}

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  private expoBinary(worktreePath: string): string {
    return `${worktreePath.replace(TRAILING_SLASH, "")}/node_modules/.bin/expo`
  }

  private async devices(): Promise<readonly SimulatorDevice[]> {
    const result = await this.deps.exec(
      "xcrun",
      ["simctl", "list", "devices", "available", "--json"],
      { timeoutMs: 10_000 }
    )
    if (result.code !== 0) {
      throw new Error(
        "Xcode Simulator tools are unavailable. Install Xcode, open it once, and retry."
      )
    }
    return parseSimulatorDevices(result.stdout)
  }

  async inspect(input: ExpoSessionInput): Promise<ExpoReadiness> {
    if (this.deps.platform !== "darwin") {
      return failure("Expo iOS Preview currently requires macOS and Xcode Simulator.")
    }
    if (!input.worktreePath) {
      return failure("This session has no worktree to run Expo from.")
    }
    if (!(await this.deps.exists(this.expoBinary(input.worktreePath)))) {
      return failure(
        "Expo is not installed in this worktree. Install the project's dependencies and retry."
      )
    }
    try {
      const devices = await this.devices()
      if (devices.length === 0) {
        return failure("No available iOS Simulator runtime was found in Xcode.")
      }
      const booted = devices.filter((device) => device.state === "Booted")
      if (booted.length > 1) {
        return failure(
          "More than one iOS Simulator is booted. Shut down all but the preview target and retry."
        )
      }
      return booted[0] ? { ready: true, simulator: booted[0] } : { ready: true }
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : String(cause))
    }
  }

  private appendOutput(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const cleaned = cleanLine(line, this.owner?.worktreePath)
      if (cleaned.length === 0) continue
      this.logs.push(cleaned)
      if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
      if (this.phase === "starting" && READY_OUTPUT.test(cleaned)) this.phase = "running"
    }
  }

  start(input: ExpoSessionInput): Promise<ExpoStatus> {
    return this.transition(() => this.startTransition(input))
  }

  private async startTransition(input: ExpoSessionInput): Promise<ExpoStatus> {
    if (this.process) {
      if (this.owner?.sessionId === input.sessionId) return await this.status(input)
      throw new Error("Another session already owns the Expo iOS preview. Stop it before starting this one.")
    }
    const readiness = await this.inspect(input)
    if (!(readiness.ready && input.worktreePath)) {
      throw new Error(readiness.reason ?? "Expo iOS Preview is not ready.")
    }

    const generation = ++this.generation
    this.owner = input
    this.simulator = readiness.simulator ?? null
    this.phase = "starting"
    this.logs = []
    this.error = undefined
    let exited = false
    try {
      const process = await this.deps.spawn(
        this.expoBinary(input.worktreePath),
        ["start", "--ios"],
        input.worktreePath,
        {
          output: (chunk) => {
            if (generation === this.generation) this.appendOutput(chunk)
          },
          exit: (code, signal) => {
            exited = true
            if (generation !== this.generation) return
            this.process = null
            if (this.phase === "stopped") return
            if (code === 0) {
              this.phase = "stopped"
              this.error = undefined
            } else {
              this.phase = "failed"
              this.error = `Expo exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`
            }
          }
        }
      )
      if (generation !== this.generation) {
        await process.terminate()
      } else if (!exited) {
        this.process = process
      }
    } catch (cause) {
      if (generation === this.generation) {
        this.phase = "failed"
        this.error = cause instanceof Error ? cause.message : String(cause)
        this.owner = null
        this.simulator = null
      }
      throw cause
    }
    return await this.status(input)
  }

  async status(input: ExpoSessionInput): Promise<ExpoStatus> {
    const readiness = await this.inspect(input)
    if (this.owner?.sessionId !== input.sessionId) {
      return { ...readiness, phase: "idle", logs: [] }
    }
    const activeReadiness = this.simulator
      ? { ...readiness, simulator: this.simulator }
      : readiness
    const status: ExpoStatus = {
      ...activeReadiness,
      phase: this.phase,
      sessionId: input.sessionId,
      logs: [...this.logs]
    }
    return this.error ? { ...status, error: this.error } : status
  }

  async reload(input: ExpoSessionInput): Promise<ExpoStatus> {
    this.assertOwner(input)
    if (!this.process) throw new Error("The Expo preview is not running.")
    await this.process.write("r\n")
    this.appendOutput("Reload requested from Jingler.")
    return await this.status(input)
  }

  async openSimulator(): Promise<void> {
    await this.deps.openSimulator()
  }

  async frame(input: ExpoSessionInput): Promise<ExpoFrame> {
    this.assertOwner(input)
    if (!this.process || (this.phase !== "starting" && this.phase !== "running")) {
      throw new Error("The Expo preview is not running.")
    }
    const generation = this.generation
    if (this.captureInFlight?.generation === generation) {
      return await this.captureInFlight.promise
    }
    const promise = this.captureFrame(generation)
    this.captureInFlight = { generation, promise }
    try {
      return await promise
    } finally {
      if (this.captureInFlight?.promise === promise) this.captureInFlight = null
    }
  }

  private async captureFrame(generation: number): Promise<ExpoFrame> {
    let device = this.simulator
    if (!device) {
      const booted = (await this.devices()).filter((candidate) => candidate.state === "Booted")
      if (booted.length !== 1) {
        throw new Error(
          booted.length === 0
            ? "Expo is still waiting for an iOS Simulator to boot."
            : "More than one iOS Simulator is booted; the Expo preview target is ambiguous."
        )
      }
      device = booted[0]!
      if (generation === this.generation) this.simulator = device
    }
    const pngBase64 = await this.deps.capture(device.udid)
    if (generation !== this.generation) {
      throw new Error("The Expo preview changed while its frame was being captured.")
    }
    if (!pngBase64) throw new Error("The iOS Simulator returned an empty screenshot.")
    return { pngBase64, capturedAt: this.deps.now(), device }
  }

  stop(input: ExpoSessionInput): Promise<ExpoStatus> {
    return this.transition(async () => {
      this.assertOwner(input)
      this.invalidatePreview()
      await this.process?.terminate()
      this.process = null
      return await this.status(input)
    })
  }

  dispose(): Promise<void> {
    return this.transition(async () => {
      this.invalidatePreview()
      const process = this.process
      this.process = null
      this.owner = null
      await process?.terminate()
    })
  }

  private invalidatePreview(): void {
    this.generation += 1
    this.phase = "stopped"
    this.simulator = null
    this.captureInFlight = null
  }

  private assertOwner(input: ExpoSessionInput): void {
    if (this.owner?.sessionId !== input.sessionId) {
      throw new Error("This session does not own the active Expo iOS preview.")
    }
  }
}
