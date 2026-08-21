import { spawn } from "node:child_process"
import * as v from "valibot"

export interface AutomationCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface AutomationCommandOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

export type AutomationCommandRunner = (
  command: string,
  args: readonly string[],
  options: AutomationCommandOptions
) => Promise<AutomationCommandResult>

export const AutomationSelectorSchema = v.pipe(
  v.object({
    identifier: v.optional(v.pipe(v.string(), v.nonEmpty())),
    label: v.optional(v.pipe(v.string(), v.nonEmpty())),
    text: v.optional(v.pipe(v.string(), v.nonEmpty()))
  }),
  v.check(
    (selector) => [selector.identifier, selector.label, selector.text]
      .filter((value) => value !== undefined).length === 1,
    "Provide exactly one non-empty identifier, label, or text selector."
  )
)

export const AutomationTimeoutSchema = v.pipe(
  v.number(),
  v.minValue(0.1),
  v.maxValue(30)
)
const AutomationActionSchema = v.variant("kind", [
  v.object({ kind: v.literal("describe") }),
  v.object({
    kind: v.literal("wait"),
    selector: AutomationSelectorSchema,
    timeout: v.optional(AutomationTimeoutSchema)
  }),
  v.object({
    kind: v.literal("tap"),
    selector: AutomationSelectorSchema,
    timeout: v.optional(AutomationTimeoutSchema)
  }),
  v.object({
    kind: v.literal("type"),
    selector: AutomationSelectorSchema,
    text: v.string(),
    replace: v.optional(v.boolean()),
    timeout: v.optional(AutomationTimeoutSchema)
  }),
  v.object({
    kind: v.literal("swipe"),
    direction: v.picklist(["up", "down", "left", "right"])
  }),
  v.object({
    kind: v.literal("button"),
    button: v.literal("home")
  })
])
export type AutomationAction = v.InferOutput<typeof AutomationActionSchema>
export const decodeAutomationAction = v.parser(AutomationActionSchema)

const SuccessfulResultSchema = v.object({
  ok: v.literal(true),
  kind: v.string(),
  value: v.nullable(v.string())
})
const DriverResultSchema = v.variant("ok", [
  SuccessfulResultSchema,
  v.object({
    ok: v.literal(false),
    kind: v.string(),
    error: v.string()
  })
])
const decodeDriverResult = v.parser(DriverResultSchema)
type DriverResult = v.InferOutput<typeof DriverResultSchema>
export type AutomationResult = v.InferOutput<typeof SuccessfulResultSchema>

const ExpoConfigSchema = v.object({
  ios: v.optional(v.object({
    bundleIdentifier: v.optional(v.pipe(v.string(), v.nonEmpty()))
  }))
})
const decodeExpoConfig = v.parser(ExpoConfigSchema)

export interface ExpoAutomationOptions {
  readonly projectPath: string
  readonly derivedDataPath: string
  readonly runCommand?: AutomationCommandRunner
  readonly removeDerivedData?: () => Promise<void>
}

const MAX_OUTPUT = 1_000_000
const MARKER = /JINGLER_EXPO_RESULT:([A-Za-z0-9+/=]+)/u
const TRAILING_SLASH = /\/$/u
const EXPO_GO_BUNDLE_ID = "host.exp.Exponent"

const abortMessage = (signal: AbortSignal): string =>
  signal.reason === "timeout" ? "Expo automation timed out." : "Expo automation was cancelled."

export const spawnAutomationCommand: AutomationCommandRunner = (
  command,
  args,
  options
) => new Promise((resolve, reject) => {
  if (options.signal.aborted) {
    reject(new Error(abortMessage(options.signal)))
    return
  }
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  const append = (current: string, chunk: Buffer): string =>
    `${current}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT)
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })

  let settled = false
  const terminate = (reason: string): void => {
    if (settled) return
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
    }
    reject(new Error(reason))
    settled = true
  }
  const onAbort = (): void => terminate(abortMessage(options.signal))
  options.signal.addEventListener("abort", onAbort, { once: true })
  const timeout = setTimeout(() => terminate("Expo automation timed out."), options.timeoutMs)

  child.once("error", (cause) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    options.signal.removeEventListener("abort", onAbort)
    reject(cause)
  })
  child.once("exit", (code) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    options.signal.removeEventListener("abort", onAbort)
    resolve({ code: code ?? 1, stdout, stderr })
  })
})

export const parseAutomationResult = (output: string): AutomationResult => {
  const encoded = MARKER.exec(output)?.[1]
  if (!encoded) throw new Error("XCTest returned no Expo automation result.")
  let result: DriverResult
  try {
    result = decodeDriverResult(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
    )
  } catch {
    throw new Error("XCTest returned an invalid Expo automation result.")
  }
  if (!result.ok) throw new Error(result.error)
  return result
}

export const resolveExpoBundleIdentifier = async (
  worktreePath: string,
  signal: AbortSignal,
  runCommand: AutomationCommandRunner = spawnAutomationCommand
): Promise<string> => {
  const expo = `${worktreePath.replace(TRAILING_SLASH, "")}/node_modules/.bin/expo`
  try {
    const result = await runCommand(expo, ["config", "--json"], {
      cwd: worktreePath,
      signal,
      timeoutMs: 30_000
    })
    if (result.code === 0) {
      const config = decodeExpoConfig(JSON.parse(result.stdout))
      if (config.ios?.bundleIdentifier) return config.ios.bundleIdentifier
    }
  } catch (cause) {
    if (signal.aborted) throw new Error(abortMessage(signal))
    if (cause instanceof Error && cause.message.includes("cancelled")) throw cause
  }
  return EXPO_GO_BUNDLE_ID
}

export class ExpoAutomationController {
  private tail = Promise.resolve()
  private built = false
  private readonly runCommand

  constructor(private readonly options: ExpoAutomationOptions) {
    this.runCommand = options.runCommand ?? spawnAutomationCommand
  }

  run(
    action: AutomationAction,
    worktreePath: string,
    simulatorUdid: string,
    signal: AbortSignal
  ): Promise<AutomationResult> {
    const task = this.tail.then(() => this.execute(action, worktreePath, simulatorUdid, signal))
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private xcodeArgs(simulatorUdid: string): string[] {
    return [
      "-project", this.options.projectPath,
      "-scheme", "ExpoAutomationUITests",
      "-sdk", "iphonesimulator",
      "-destination", `platform=iOS Simulator,id=${simulatorUdid}`,
      "-derivedDataPath", this.options.derivedDataPath
    ]
  }

  private async execute(
    action: AutomationAction,
    worktreePath: string,
    simulatorUdid: string,
    signal: AbortSignal
  ): Promise<AutomationResult> {
    if (signal.aborted) throw new Error(abortMessage(signal))
    const args = this.xcodeArgs(simulatorUdid)
    if (!this.built) {
      const build = await this.runCommand("xcodebuild", [
        ...args,
        "build-for-testing",
        "CODE_SIGNING_ALLOWED=NO"
      ], { signal, timeoutMs: 120_000 })
      if (build.code !== 0) {
        throw new Error(build.stderr.trim() || "XCTest automation driver failed to build.")
      }
      this.built = true
    }
    const bundleId = await resolveExpoBundleIdentifier(worktreePath, signal, this.runCommand)
    const result = await this.runCommand("xcodebuild", [
      ...args,
      "test-without-building",
      "-only-testing:ExpoAutomationUITests/ExpoAutomationUITests/testAction"
    ], {
      signal,
      timeoutMs: 60_000,
      env: {
        JINGLER_EXPO_ACTION: Buffer.from(JSON.stringify(action)).toString("base64"),
        JINGLER_EXPO_BUNDLE_ID: bundleId
      }
    })
    try {
      return parseAutomationResult(`${result.stdout}\n${result.stderr}`)
    } catch (cause) {
      if (result.code === 0 || !(cause instanceof Error)) throw cause
      throw new Error(
        cause.message === "XCTest returned no Expo automation result."
          ? result.stderr.trim() || "Expo automation failed."
          : cause.message
      )
    }
  }

  async dispose(): Promise<void> {
    await this.tail
    await this.options.removeDerivedData?.()
  }
}
