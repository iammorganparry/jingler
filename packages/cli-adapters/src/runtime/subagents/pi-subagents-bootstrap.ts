import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { Data, Effect } from "effect"
import {
  defaultPiChildLauncherConfig,
  preparePiChildLauncher
} from "./pi-child-launcher.js"

const require = createRequire(import.meta.url)
export const PI_SUBAGENTS_EXTENSION_PATH = require.resolve("pi-subagents")

const CONFIG = {
  artifactDir: "session",
  asyncByDefault: true,
  asyncWidget: false,
  fleetView: false,
  inlineToolDisplay: "summary",
  missions: { enabled: false },
  toolDescriptionMode: "compact"
} as const

export class PiSubagentsBootstrapError extends Data.TaggedError(
  "PiSubagentsBootstrapError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const configPath = (agentDir: string): string =>
  join(agentDir, "extensions", "subagent", "config.json")

const sameConfig = async (path: string): Promise<boolean> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return JSON.stringify(parsed) === JSON.stringify(CONFIG)
  } catch {
    return false
  }
}

const writeConfig = async (path: string): Promise<void> => {
  if (await sameConfig(path)) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.next`
  try {
    await writeFile(temporary, `${JSON.stringify(CONFIG, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Prepare pi-subagents for Jingler's embedded host.
 *
 * The extension resolves configuration dynamically from PI_CODING_AGENT_DIR,
 * including after its factory has registered event handlers. Jingler therefore
 * pins the process-wide value to its one app-owned agent directory before any
 * embedded session loads. Every desktop session shares that directory; a second
 * distinct root in one process would make extension lifecycle artifacts and
 * controls ambiguous, so it fails closed.
 */
export const preparePiSubagentsRuntime = (
  agentDir: string
): Effect.Effect<void, PiSubagentsBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      const expected = resolve(agentDir)
      const configured = process.env.PI_CODING_AGENT_DIR
      if (configured !== undefined && resolve(configured) !== expected) {
        throw new Error(
          `PI_CODING_AGENT_DIR already targets a different runtime root: ${configured}`
        )
      }
      process.env.PI_CODING_AGENT_DIR = expected
      await writeConfig(configPath(expected))
      await Effect.runPromise(
        preparePiChildLauncher(defaultPiChildLauncherConfig(expected))
      )
    },
    catch: (cause) =>
      new PiSubagentsBootstrapError({
        message: "Could not prepare the embedded pi-subagents runtime",
        cause
      })
  })
