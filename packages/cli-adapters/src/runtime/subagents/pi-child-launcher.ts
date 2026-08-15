import { createRequire } from "node:module"
import { access, chmod } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"

const require = createRequire(import.meta.url)

export const JINGLER_SUBAGENT_CREDENTIAL_ROOT =
  "JINGLER_SUBAGENT_CREDENTIAL_ROOT"
export const JINGLER_SUBAGENT_PI_CLI = "JINGLER_SUBAGENT_PI_CLI"
export const JINGLER_SUBAGENT_NODE = "JINGLER_SUBAGENT_NODE"
export const JINGLER_SUBAGENT_CHILD_TOOLS = "JINGLER_SUBAGENT_CHILD_TOOLS"
export const PI_SUBAGENT_PI_BINARY = "PI_SUBAGENT_PI_BINARY"

export interface PiChildLauncherConfig {
  readonly wrapperPath: string
  readonly piCliPath: string
  readonly credentialRoot: string
  readonly nodePath: string
  readonly childToolsPath: string
}

export class PiChildLauncherError extends Data.TaggedError(
  "PiChildLauncherError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const sourcePiChildWrapperPath = (): string =>
  fileURLToPath(
    new URL("../../../runtime-assets/pi-subagent-wrapper.mjs", import.meta.url)
  )

export const sourcePiChildToolsPath = (): string =>
  fileURLToPath(
    new URL("../../../runtime-assets/jingler-child-tools.mjs", import.meta.url)
  )

export const installedPiCliPath = (): string =>
  join(
    dirname(dirname(require.resolve("pi-subagents"))),
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  )

export const defaultPiChildLauncherConfig = (
  agentDir: string
): PiChildLauncherConfig => ({
  wrapperPath:
    process.env.JINGLER_SUBAGENT_WRAPPER_PATH ?? sourcePiChildWrapperPath(),
  piCliPath: process.env.JINGLER_SUBAGENT_PI_CLI_PATH ?? installedPiCliPath(),
  credentialRoot: join(agentDir, "subagent-credentials"),
  nodePath: process.execPath,
  childToolsPath:
    process.env.JINGLER_SUBAGENT_CHILD_TOOLS_PATH ?? sourcePiChildToolsPath()
})

const pinEnvironment = (name: string, value: string): void => {
  const expected = resolve(value)
  const current = process.env[name]
  if (current !== undefined && resolve(current) !== expected) {
    throw new Error(`${name} already targets a different path: ${current}`)
  }
  process.env[name] = expected
}

export const preparePiChildLauncher = (
  config: PiChildLauncherConfig
): Effect.Effect<void, PiChildLauncherError> =>
  Effect.tryPromise({
    try: async () => {
      await Promise.all([
        access(config.wrapperPath),
        access(config.piCliPath),
        access(config.childToolsPath)
      ])
      if (process.platform !== "win32") await chmod(config.wrapperPath, 0o755)
      pinEnvironment(PI_SUBAGENT_PI_BINARY, config.wrapperPath)
      pinEnvironment(JINGLER_SUBAGENT_PI_CLI, config.piCliPath)
      pinEnvironment(JINGLER_SUBAGENT_CREDENTIAL_ROOT, config.credentialRoot)
      pinEnvironment(JINGLER_SUBAGENT_NODE, config.nodePath)
      pinEnvironment(JINGLER_SUBAGENT_CHILD_TOOLS, config.childToolsPath)
    },
    catch: (cause) =>
      new PiChildLauncherError({
        message: "Could not prepare the pi-subagents child launcher",
        cause
      })
  })
