import { access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"

export const JINGLER_SUBAGENT_CREDENTIAL_ROOT =
  "JINGLER_SUBAGENT_CREDENTIAL_ROOT"
export const JINGLER_SUBAGENT_NODE = "JINGLER_SUBAGENT_NODE"
export const JINGLER_SUBAGENT_CHILD_TOOLS = "JINGLER_SUBAGENT_CHILD_TOOLS"
export const PI_SUBAGENT_ELECTRON_RUN_AS_NODE =
  "PI_SUBAGENT_ELECTRON_RUN_AS_NODE"
export const JINGLER_SUBAGENT_PROCESS_ISOLATION =
  "JINGLER_SUBAGENT_PROCESS_ISOLATION"

export interface PiChildLauncherConfig {
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

export const sourcePiChildToolsPath = (): string =>
  fileURLToPath(
    new URL("../../../runtime-assets/jingler-child-tools.mjs", import.meta.url)
  )

export const defaultPiChildLauncherConfig = (
  agentDir: string
): PiChildLauncherConfig => ({
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

const pinValue = (name: string, value: string): void => {
  const current = process.env[name]
  if (current !== undefined && current !== value) {
    throw new Error(`${name} already has a different managed value`)
  }
  process.env[name] = value
}

export const preparePiChildLauncher = (
  config: PiChildLauncherConfig
): Effect.Effect<void, PiChildLauncherError> =>
  Effect.tryPromise({
    try: async () => {
      await Promise.all([
        access(config.childToolsPath),
        access(config.nodePath)
      ])
      pinValue(JINGLER_SUBAGENT_PROCESS_ISOLATION, "1")
      pinValue(PI_SUBAGENT_ELECTRON_RUN_AS_NODE, "1")
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
