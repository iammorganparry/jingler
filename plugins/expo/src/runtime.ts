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
  readonly write: (input: string) => void
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

interface SimctlDevice {
  readonly udid?: unknown
  readonly name?: unknown
  readonly state?: unknown
  readonly isAvailable?: unknown
}

interface SimctlListPayload {
  readonly devices?: Readonly<Record<string, readonly SimctlDevice[]>>
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
const READY_OUTPUT = /(?:Metro waiting|Waiting on|Opening (?:the app )?on iOS|exp:\/\/)/i
const MAX_LOG_LINES = 100

const cleanLine = (line: string, worktreePath?: string): string => {
  const withoutAnsi = line.replace(ANSI, "").replaceAll("\r", "").trimEnd()
  return worktreePath ? withoutAnsi.replaceAll(worktreePath, "<worktree>") : withoutAnsi
}

export const parseSimulatorDevices = (json: string): readonly SimulatorDevice[] => {
  let value: SimctlListPayload
  try {
    value = JSON.parse(json) as SimctlListPayload
  } catch {
    throw new Error("Xcode returned invalid Simulator device data.")
  }
  const runtimes = value.devices
  if (typeof runtimes !== "object" || runtimes === null) {
    throw new Error("Xcode returned invalid Simulator device data.")
  }
  const devices: SimulatorDevice[] = []
  for (const runtimeDevices of Object.values(runtimes)) {
    if (!Array.isArray(runtimeDevices)) continue
    for (const raw of runtimeDevices as SimctlDevice[]) {
      if (
        raw.isAvailable !== false &&
        typeof raw.udid === "string" &&
        typeof raw.name === "string" &&
        typeof raw.state === "string"
      ) {
        devices.push({ udid: raw.udid, name: raw.name, state: raw.state })
      }
    }
  }
  return devices
}

const failure = (reason: string): ExpoReadiness => ({ ready: false, reason })

export class ExpoPreviewController {
  private process: ManagedProcess | null = null
  private phase: ExpoStatus["phase"] = "idle"
  private owner: ExpoSessionInput | null = null
  private logs: string[] = []
  private error: string | undefined
  private captureInFlight: Promise<ExpoFrame> | null = null

  constructor(private readonly deps: ExpoRuntimeDependencies) {}

  private expoBinary(worktreePath: string): string {
    return `${worktreePath.replace(/\/$/u, "")}/node_modules/.bin/expo`
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
      return { ready: true, simulator: devices.find((device) => device.state === "Booted") }
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

  async start(input: ExpoSessionInput): Promise<ExpoStatus> {
    if (this.process) {
      if (this.owner?.sessionId === input.sessionId) return await this.status(input)
      throw new Error("Another session already owns the Expo iOS preview. Stop it before starting this one.")
    }
    const readiness = await this.inspect(input)
    if (!(readiness.ready && input.worktreePath)) {
      throw new Error(readiness.reason ?? "Expo iOS Preview is not ready.")
    }

    this.owner = input
    this.phase = "starting"
    this.logs = []
    this.error = undefined
    try {
      this.process = await this.deps.spawn(
        this.expoBinary(input.worktreePath),
        ["start", "--ios"],
        input.worktreePath,
        {
          output: (chunk) => this.appendOutput(chunk),
          exit: (code, signal) => {
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
    } catch (cause) {
      this.phase = "failed"
      this.error = cause instanceof Error ? cause.message : String(cause)
      this.owner = null
      throw cause
    }
    return await this.status(input)
  }

  async status(input: ExpoSessionInput): Promise<ExpoStatus> {
    const readiness = await this.inspect(input)
    const ownsPreview = this.owner?.sessionId === input.sessionId
    return {
      ...readiness,
      phase: ownsPreview ? this.phase : "idle",
      ...(ownsPreview ? { sessionId: input.sessionId, logs: [...this.logs] } : { logs: [] }),
      ...(ownsPreview && this.error ? { error: this.error } : {})
    }
  }

  async reload(input: ExpoSessionInput): Promise<ExpoStatus> {
    this.assertOwner(input)
    if (!this.process) throw new Error("The Expo preview is not running.")
    this.process.write("r\n")
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
    if (this.captureInFlight) return await this.captureInFlight
    const capture = this.captureFrame()
    this.captureInFlight = capture
    try {
      return await capture
    } finally {
      if (this.captureInFlight === capture) this.captureInFlight = null
    }
  }

  private async captureFrame(): Promise<ExpoFrame> {
    const device = (await this.devices()).find((candidate) => candidate.state === "Booted")
    if (!device) throw new Error("Expo is still waiting for an iOS Simulator to boot.")
    const pngBase64 = await this.deps.capture(device.udid)
    if (!pngBase64) throw new Error("The iOS Simulator returned an empty screenshot.")
    if (this.phase === "starting") this.phase = "running"
    return { pngBase64, capturedAt: this.deps.now(), device }
  }

  async stop(input: ExpoSessionInput): Promise<ExpoStatus> {
    this.assertOwner(input)
    this.phase = "stopped"
    const process = this.process
    this.process = null
    await process?.terminate()
    return await this.status(input)
  }

  async dispose(): Promise<void> {
    this.phase = "stopped"
    const process = this.process
    this.process = null
    this.owner = null
    this.captureInFlight = null
    await process?.terminate()
  }

  private assertOwner(input: ExpoSessionInput): void {
    if (this.owner?.sessionId !== input.sessionId) {
      throw new Error("This session does not own the active Expo iOS preview.")
    }
  }
}
